# SETUP-HARLEY.md

How to wire up the magic-link auth on `/harley`.

This replaces the old `?token=…` URL auth (PR #26). Once verified end-to-end, a follow-up PR deletes the legacy `HARLEY_ADMIN_TOKEN` env var.

## Channels

- **PRIMARY: email** via Resend, sent to `HARLEY_EMAIL` (source-hardcoded constant in `src/lib/harley-auth.ts`).
- **TRIPWIRE: Telegram** — same URL POSTed to `TRIPWIRE_TELEGRAM_CHAT_ID`, a private channel Harley controls. The bot has **no other purpose**: a one-way audit fan-out. Anything that lands in that channel which Harley didn't request is the breach signal.

The endpoint is tolerant of partial failure — as long as one channel delivers, the request succeeds. Both failing returns 502.

## Architecture

```
Harley taps "Send access link"          /harley page (Server Component)
        │                                       │
        ▼                                       ▼ checks harley_session JWT cookie
POST /api/harley/login-request          ── valid? render <HarleyForm />
        │                               ── invalid/missing? render <LoginButton />
        ├─ rate-limit by IP (3/hr, 10/day, persisted in "Magic Link Audit")
        ├─ generate 32-char token, persist row in "Magic Links" (15-min TTL)
        ├─ EMAIL via Resend → HARLEY_EMAIL (primary)
        ├─ POST to Telegram Bot API → TRIPWIRE_TELEGRAM_CHAT_ID (parallel, audit-only)
        └─ audit-log every step
                ▼
Harley taps the link in her email (or in Telegram if email is misbehaving)
                │
                ▼
GET /harley/verify?t=…
        │
        ├─ validate unused + unexpired
        ├─ mark used_at
        ├─ sign 24h HS256 JWT, set httpOnly secure SameSite=lax cookie
        └─ 302 → /harley   (cookie now present, form renders)
```

## Source-hardcoded identities

`src/lib/harley-auth.ts` exports:

- `HARLEY_EMAIL: string` — the primary recipient
- `TRIPWIRE_TELEGRAM_CHAT_ID: number` — the audit channel chat_id

Both ship as placeholders (`""` and `0`). Any push that touches this file makes the GitHub `notify-harley` email subject begin with **"AUTH CONFIG CHANGED — "** so unexpected edits are immediately obvious.

The fingerprint endpoint at `/api/harley/auth-config-fingerprint` returns:

```json
{ "hash": "<sha256>" }
```

…over `${HARLEY_EMAIL}|${TRIPWIRE_TELEGRAM_CHAT_ID}`. Record the hash once and re-check on a cadence; a change means the constants were edited.

## Env vars (Vercel — mark as Sensitive)

| Name | What | Where to get it |
|------|------|-----------------|
| `RESEND_API_KEY` | Resend API key (already exists in env for other email helpers) | Resend dashboard |
| `TELEGRAM_BOT_TOKEN` | Bot API token (`123456:AbcDef…`) | BotFather |
| `HARLEY_JWT_SECRET` | 32 random bytes for signing `harley_session` cookies | `openssl rand -hex 32` |
| `TELEGRAM_WEBHOOK_SECRET` | optional shared secret for `/api/telegram/webhook` | `openssl rand -hex 32` |

After setting any env var: redeploy production once for it to take effect.

## End-to-end bootstrap

Steps Dan does (numbered) and steps Harley does (italic).

### 1. Create the Telegram bot

Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts. Pick a public name and a unique username ending in `bot`. BotFather replies with the API token.

```
TELEGRAM_BOT_TOKEN=123456:AaBbCcDd...
```

### 2. Set env vars in Vercel

```bash
echo "$TELEGRAM_BOT_TOKEN" | vercel env add TELEGRAM_BOT_TOKEN production --sensitive
openssl rand -hex 32 | vercel env add HARLEY_JWT_SECRET production --sensitive
openssl rand -hex 32 | vercel env add TELEGRAM_WEBHOOK_SECRET production --sensitive
```

Repeat with `preview` and `development` as desired. `RESEND_API_KEY` is already set.

### 3. Register the Telegram webhook

Replace `<TOKEN>`, `<SECRET>`, `<PROD-DOMAIN>`:

```bash
curl -fsS \
  -F "url=https://<PROD-DOMAIN>/api/telegram/webhook" \
  -F "secret_token=<SECRET>" \
  https://api.telegram.org/bot<TOKEN>/setWebhook
```

Response should be `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 4. Set up the tripwire channel

Create a private Telegram channel (any name). Add the bot as an admin with **Post Messages** permission.

To surface the channel's chat_id (a negative integer like `-100xxxxxxxxxx`) — easiest path: send any one-off message in the channel, then call `getUpdates`:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].channel_post.chat'
```

The `id` is the value to paste as `TRIPWIRE_TELEGRAM_CHAT_ID`.

> The bot's `/start` reply (handled by `/api/telegram/webhook`) is `chat_id: <id>`. That works for DMs but typically not in channels (channels are broadcast-only and don't deliver `/start`). Use `getUpdates` for the channel.

### 5. Plug in identities

Edit `src/lib/harley-auth.ts`:

```ts
export const HARLEY_EMAIL = "harley@example.com";          // her primary email
export const TRIPWIRE_TELEGRAM_CHAT_ID = -1001234567890;   // from step 4
```

Open it as **its own PR** so the diff is auditable. The `notify-harley` email for that push will be subject-prefixed **"AUTH CONFIG CHANGED — "** — the first live demo of the tamper-evident wiring.

After merge + redeploy, the `/harley` "Send access link" button starts working end-to-end.

### 6. *Harley records the fingerprint*

*Open `https://<PROD-DOMAIN>/api/harley/auth-config-fingerprint`. Copy the `hash` value somewhere safe (1Password note, paper, etc.). Bookmark this URL.*

*Re-check the URL whenever the deploy email reads "AUTH CONFIG CHANGED — …". A new hash means the constants in source were actually edited; an unchanged hash means the prefix was a false alarm or a non-id edit (formatting, comments).*

### 7. *Harley bookmarks /harley*

*Bookmark `https://<PROD-DOMAIN>/harley`. Tapping it shows a single button: "Send access link to Telegram". One tap, then check email (or Telegram) for the magic link, tap the link, the control panel renders.*

## Operational notes

- **Magic-link TTL**: 15 minutes. After that, any unused link returns "Link expired."
- **One-shot**: every link is single-use. Re-tapping a used link returns "Link already used."
- **Session length**: 24 hours. After expiry, tap "Send access link" again.
- **Rate limit**: 3 requests/hour, 10/day per IP. Hits are recorded in `Magic Link Audit`.
- **Forensics**: every request, send (success or fail), verify (success or fail), and rate-limit hit appends a row to the `Magic Link Audit` tab in the Sheet.
- **Tripwire**: every login attempt is delivered to the Telegram channel **as well as** the email. If Harley sees a link in the channel that she didn't request from the email, that's the breach signal.

## Rolling back the legacy `?token=` auth

After this PR is verified end-to-end, a follow-up PR removes:

```bash
vercel env rm HARLEY_ADMIN_TOKEN production
vercel env rm HARLEY_ADMIN_TOKEN preview
vercel env rm HARLEY_ADMIN_TOKEN development
```

The query-string auth path is already gone in this PR — `/harley` no longer reads `?token=`.
