/**
 * Telegram fan-out helper. Mirror of sendHarleyEmail() — used for
 * notifications where Email volume would spam (e.g. per-edge alerts
 * during a marathon edge session).
 *
 * Channel resolution:
 *   1. HARLEY_TELEGRAM_CHAT_ID env var (numeric) — preferred when set,
 *      points at Harley's private channel/DM with the bot.
 *   2. TRIPWIRE_TELEGRAM_CHAT_ID constant from src/lib/harley-auth.ts —
 *      fallback during bootstrap, currently Dan's own DM with the bot.
 *
 * Bot token must be in TELEGRAM_BOT_TOKEN env var. If missing, the
 * helper logs a warning and returns { sent: false } without throwing
 * so the calling flow never fails because alerts aren't configured.
 */
import { TRIPWIRE_TELEGRAM_CHAT_ID } from "./harley-auth";

export type TelegramResult =
  | { sent: true; chatId: number }
  | { sent: false; reason: string };

function harleyChatId(): number {
  const env = process.env.HARLEY_TELEGRAM_CHAT_ID || "";
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return TRIPWIRE_TELEGRAM_CHAT_ID;
}

export async function sendHarleyTelegram(text: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN missing — skipping send.");
    return { sent: false, reason: "TELEGRAM_BOT_TOKEN missing" };
  }
  const chatId = harleyChatId();
  if (!chatId) {
    console.warn("[telegram] no chat id resolved — skipping send.");
    return { sent: false, reason: "chat id missing" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage ${res.status}: ${body.slice(0, 300)}`);
      return { sent: false, reason: `telegram_${res.status}` };
    }
    return { sent: true, chatId };
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[telegram] send failed:", msg);
    return { sent: false, reason: msg };
  }
}
