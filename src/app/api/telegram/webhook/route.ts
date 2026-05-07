/**
 * POST /api/telegram/webhook
 *
 * Single-purpose webhook: only handles `/start`. Replies with
 * `chat_id: <id>` so the TRIPWIRE_TELEGRAM_CHAT_ID constant in
 * src/lib/harley-auth.ts can be bootstrapped once. Everything else
 * (any other text, stickers, edits, group events) is silently ignored.
 * The bot is a one-way audit channel for magic-link sends — it does
 * not accept commands.
 *
 * Set the webhook with:
 *   curl -F "url=https://<prod>/api/telegram/webhook" \
 *        -F "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *        https://api.telegram.org/bot<TOKEN>/setWebhook
 *
 * If TELEGRAM_WEBHOOK_SECRET is set, requests must carry the matching
 * x-telegram-bot-api-secret-token header — Telegram does this when
 * setWebhook is called with secret_token. If unset, the route accepts
 * unauthenticated POSTs (fine for the bootstrap window; lock it down by
 * setting the env var once the bot is in production use).
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramChat = { id: number; type: string };
type TelegramMessage = { chat?: TelegramChat; text?: string };
type TelegramUpdate = {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

async function reply(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("[telegram webhook] reply failed:", (e as Error).message);
  }
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (expectedSecret) {
    const provided = req.headers.get("x-telegram-bot-api-secret-token") || "";
    if (provided !== expectedSecret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  let body: TelegramUpdate;
  try {
    body = (await req.json()) as TelegramUpdate;
  } catch {
    // Telegram retries on non-2xx, so swallow malformed bodies cleanly.
    return NextResponse.json({ ok: true });
  }

  const message = body.message ?? body.channel_post;
  const chatId = message?.chat?.id;
  const text = (message?.text ?? "").trim();
  if (!chatId || !text) return NextResponse.json({ ok: true });

  // /start can be plain or namespaced as `/start@bot_username`.
  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    if (botToken) {
      await reply(botToken, chatId, `chat_id: ${chatId}`);
    } else {
      console.warn("[telegram webhook] TELEGRAM_BOT_TOKEN missing — skipping reply.");
    }
  }

  return NextResponse.json({ ok: true });
}
