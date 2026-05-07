/**
 * Harley auth identities — SOURCE OF TRUTH for who receives login
 * delivery and audit copies. Changing these values is a security-
 * sensitive event: the notify-harley GitHub Action prepends "AUTH
 * CONFIG CHANGED — " to the email subject for any push that touches
 * this file, so unexpected edits are visible to Harley immediately.
 *
 * Channels:
 *   HARLEY_EMAIL — PRIMARY delivery for magic-link URLs (via Resend).
 *   TRIPWIRE_TELEGRAM_CHAT_ID — one-way audit fan-out. The same URL
 *   is POSTed to this Telegram chat. The bot has no other purpose
 *   (the only inbound it handles is /start, which replies with the
 *   caller's chat_id so this constant can be bootstrapped once).
 *
 * If either channel fails, the request still succeeds as long as the
 * other delivered — the audit log records the failure either way. We
 * don't want a single broken channel to lock Harley out.
 *
 * Bootstrap (after this PR ships and TELEGRAM_BOT_TOKEN is in Vercel):
 *  1. Fill in HARLEY_EMAIL with Harley's primary address.
 *  2. Harley creates a private Telegram channel, adds the bot as an
 *     admin, sends any message in it. Surface the channel chat_id
 *     (a negative integer like -100xxxxxxxxxx) via getUpdates. Paste
 *     as TRIPWIRE_TELEGRAM_CHAT_ID.
 *  3. Open both edits as their own PR so the diff is auditable —
 *     that push's notify-harley email will be subject-prefixed
 *     "AUTH CONFIG CHANGED — ", which is the first live demo of the
 *     tamper-evident wiring.
 *
 * The fingerprint endpoint at /api/harley/auth-config-fingerprint
 * hashes these two values together so external monitoring (or Harley
 * herself) can detect tampering by comparing against a previously
 * recorded hash.
 */

// During development Daniel is the magic-link recipient via Telegram
// only — HARLEY_EMAIL is intentionally left empty so Resend stays out
// of the auth path until Harley's real address is filled in. The
// login-request route is tolerant of an empty HARLEY_EMAIL: it
// skips the email send and returns success as long as Telegram
// delivered. If BOTH channels are unbootstrapped, the route returns
// 503.
//
// Final state should fan-out to BOTH Dan's chat and Harley's chat —
// that requires turning these constants into arrays, which is its own
// follow-up PR. For now: single recipient, Dan's personal Telegram DM
// with the bot.
//
// Types are widened (`: string`, `: number`) rather than inferred so
// the runtime guards in src/app/api/harley/login-request/route.ts
// (`if (!HARLEY_EMAIL)`, `TRIPWIRE_TELEGRAM_CHAT_ID === 0`) don't get
// flagged as tautologies once the literals are populated.
export const HARLEY_EMAIL: string = "";
export const TRIPWIRE_TELEGRAM_CHAT_ID: number = 6503455232;
