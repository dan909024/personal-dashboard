/**
 * Owner-targeted Telegram sender. Always routes to Daniel's chat
 * (TRIPWIRE_TELEGRAM_CHAT_ID), never to Harley.
 *
 * Use this for "Harley added a calendar task" alerts and any other
 * notification meant for Daniel only — sendHarleyTelegram() flips to
 * Harley's chat once HARLEY_TELEGRAM_CHAT_ID is set, which is wrong
 * here.
 */
import { TRIPWIRE_TELEGRAM_CHAT_ID } from "./harley-auth";
import type { TelegramResult } from "./telegram";

export async function sendOwnerTelegram(text: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    console.warn("[owner-telegram] TELEGRAM_BOT_TOKEN missing — skipping send.");
    return { sent: false, reason: "TELEGRAM_BOT_TOKEN missing" };
  }
  const chatId = TRIPWIRE_TELEGRAM_CHAT_ID;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[owner-telegram] sendMessage ${res.status}: ${body.slice(0, 300)}`);
      return { sent: false, reason: `telegram_${res.status}` };
    }
    return { sent: true, chatId };
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[owner-telegram] send failed:", msg);
    return { sent: false, reason: msg };
  }
}
