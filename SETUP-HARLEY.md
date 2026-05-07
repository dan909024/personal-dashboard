# SETUP-HARLEY.md

How to wire up the Telegram magic-link auth on `/harley`.

This replaces the old `?token=…` URL auth (PR #26) entirely. Once this is verified end-to-end, a follow-up PR deletes the legacy `HARLEY_ADMIN_TOKEN` env var and any remaining traces.

## Architecture

```
Harley taps "Send access link"          /harley page (Server Component)
        │                                       │
        ▼                                       ▼ checks harley_session cookie
POST /api/harley/login-request          ── valid? render <HarleyForm />
        │
        ├─ rate-limit by IP (3/hr, 10/day, persisted in "Magic Link Audit")
        ├─ generate 32-char token, persist row in "Magic Links" (15-min TTL)
        ├─ send Telegram DM to BOTH HARLEY_CHAT_ID and TRIPWIRE_CHAT_ID
        └─ audit log every step
                ▼
Harley taps the link in Telegram
                │
                ▼
GET /harley/verify?t=…
        │
        ├─ validate unused + unexpired
        ├─ mark used_at
        ├─ sign 24h JWT, set httpOnly secure SameSite=lax cookie
        └─ 302 → /harley   (cookie now present, form renders)
```

## Source-hardcoded identities

`src/lib/harley-auth.ts` exports two integer constants:

- `HARLEY_CHAT_ID` — Harley's personal Telegram chat_id
- `TRIPWIRE_CHAT_ID` — a private channel chat_id where every login attempt is also delivered, so any unauthorised request is visible to a separate audit recipient

Both are placeholders (`0`) until bootstrap completes. Any push that touches this file makes the GitHub notify-harley email subject begin with **"AUTH CONFIG CHANGED — "** so unexpected edits are immediately obvious.

The fingerprint endpoint at `/api/harley/auth-config-fingerprint` returns:

```json
{ "hash": "<sha256>" }
```

…hashed over `${HARLEY_CHAT_ID}|${TRIPWIRE_CHAT_ID}`. Record the hash once and re-check on a cadence; a change means the chat IDs were edited in `src/lib/harley-auth.ts`.

## Env vars (Vercel — mark as Sensitive)

| Name | What | Where to get it |
|------|------|-----------------|
| `TELEGRAM_BOT_TOKEN` | Bot API token (`123456:AbcDef…`) | BotFather, after creating the bot |
| `HARLEY_JWT_SECRET` | 32-byte random for signing `harley_session` cookies | `openssl rand -hex 32` |
| `TELEGRAM_WEBHOOK_SECRET` | optional shared secret for `/api/telegram/webhook` | `openssl rand -hex 32` |

After setting any env var: redeploy production once for it to take effect.

## End-to-end bootstrap

Steps Dan does (numbered) and steps Harley does (italic).

### 1. Create the bot

Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts. Pick a public name (e.g. "Personal Dashboard Auth") and a unique username ending in `bot`. BotFather replies with the API token.

```
TELEGRAM_BOT_TOKEN=123456:AaBbCcDd...
```

### 2. Set env vars in Vercel

```bash
echo "$TELEGRAM_BOT_TOKEN" | vercel env add TELEGRAM_BOT_TOKEN production --sensitive
openssl rand -hex 32 | vercel env add HARLEY_JWT_SECRET production --sensitive
openssl rand -hex 32 | vercel env add TELEGRAM_WEBHOOK_SECRET production --sensitive
```

(Repeat with `preview` and `development` as desired.)

### 3. Register the webhook

Replace `<TOKEN>`, `<SECRET>`, and `<PROD-DOMAIN>`:

```bash
curl -fsS \
  -F "url=https://<PROD-DOMAIN>/api/telegram/webhook" \
  -F "secret_token=<SECRET>" \
  https://api.telegram.org/bot<TOKEN>/setWebhook
```

Response should be `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 4. *Harley discovers her chat_id*

*Open Telegram, search for the bot's username, tap "Start". The bot replies:*

> *Your Telegram chat_id is **123456789***

*Send that integer to Dan.*

### 5. Create the tripwire channel

Dan creates a private channel in Telegram (any name; "Harley Tripwire" works), adds the bot as an admin with **Post Messages** permission, sends any message in the channel.

To surface the channel's chat_id (a negative integer like `-100xxxxxxxxxx`):

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].channel_post.chat'
```

The `id` field is `TRIPWIRE_CHAT_ID`.

### 6. Plug in chat IDs

Edit `src/lib/harley-auth.ts`:

```ts
export const HARLEY_CHAT_ID = 123456789;        // from step 4
export const TRIPWIRE_CHAT_ID = -1001234567890; // from step 5
```

Open it as **its own PR** so the diff is auditable. The notify-harley email for that push will be subject-prefixed with **"AUTH CONFIG CHANGED — "**.

After merge + redeploy, the `/harley` "Send access link" button starts working.

### 7. *Harley records the fingerprint*

*Open `https://<PROD-DOMAIN>/api/harley/auth-config-fingerprint`. Copy the `hash` value somewhere safe (1Password note, paper, etc.). Bookmark this URL.*

*Re-check the URL whenever the deploy email reads "AUTH CONFIG CHANGED — …". A new hash means the chat IDs in source were edited; an unchanged hash means the prefix was a false alarm or a legitimate non-id edit (formatting, comments).*

### 8. *Harley bookmarks /harley*

*Bookmark `https://<PROD-DOMAIN>/harley`. Tapping it shows a single button: "Send access link to Telegram". One tap, then check Telegram for the magic link, tap the link, the control panel renders.*

## Operational notes

- **Magic-link TTL**: 15 minutes. After that, any unused link returns "Link expired."
- **One-shot**: every link is single-use. Re-tapping a used link returns "Link already used."
- **Session length**: 24 hours. After expiry, tap "Send access link" again.
- **Rate limit**: 3 requests/hour, 10/day per IP. Hits are recorded in `Magic Link Audit`.
- **Forensics**: every request, send (success or fail), verify (success or fail), and rate-limit hit appends a row to the `Magic Link Audit` tab in the Sheet.
- **Tripwire**: every login attempt is delivered to BOTH Harley's DM and the tripwire channel. If Harley sees a link in the channel that she didn't request, that's the breach signal.

## Rolling back the legacy `?token=` auth

After this is verified end-to-end, a follow-up PR removes:
- `HARLEY_ADMIN_TOKEN` env var (`vercel env rm HARLEY_ADMIN_TOKEN production` etc.)
- Any references in code (already removed in this PR — page no longer reads the query param)
