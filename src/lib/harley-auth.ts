/**
 * Harley auth identities — SOURCE OF TRUTH for who receives magic-link
 * notifications. Changing these values is a security-sensitive event:
 * the notify-harley GitHub Action prepends "AUTH CONFIG CHANGED — " to
 * the email subject for any push that touches this file, so unexpected
 * edits are visible to Harley immediately.
 *
 * Bootstrap flow (do AFTER the bot exists and TELEGRAM_BOT_TOKEN is set):
 *   1. Harley DMs the bot and sends `/start`. The bot replies with her
 *      personal chat_id (an integer). Paste it as HARLEY_CHAT_ID below.
 *   2. Create a private Telegram channel, add the bot as an admin, send
 *      a message in it. Surface the channel chat_id (it's a negative
 *      integer like -100xxxxxxxxxx) via getUpdates or by calling getChat
 *      from a one-off script. Paste it as TRIPWIRE_CHAT_ID.
 *   3. Open a separate PR for the values so the diff is auditable.
 *
 * The fingerprint endpoint at /api/harley/auth-config-fingerprint hashes
 * these two values together so external monitoring (or Harley herself)
 * can detect tampering by comparing against a previously recorded hash.
 */

// TODO(harley-auth): replace with Harley's personal Telegram chat_id (positive integer).
export const HARLEY_CHAT_ID = 0;

// TODO(harley-auth): replace with the private tripwire channel chat_id (negative integer like -100xxxxxxxxxx).
export const TRIPWIRE_CHAT_ID = 0;
