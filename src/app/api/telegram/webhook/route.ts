/**
 * POST /api/telegram/webhook
 *
 * Inbound Telegram updates. Two commands handled:
 *
 *   /start                   → replies with `chat_id: <id>` so
 *                              TRIPWIRE_TELEGRAM_CHAT_ID etc. can be
 *                              bootstrapped once.
 *
 *   /fine <amount> <reason>  → appends a row to the Punishments sheet.
 *                              Manual fines (rule_id empty). Restricted
 *                              to authorized chat IDs:
 *                                - HARLEY_TELEGRAM_CHAT_ID env (Harley's DM)
 *                                - DAN_TELEGRAM_CHAT_ID env (Dan's DM)
 *                                - TRIPWIRE_TELEGRAM_CHAT_ID (bootstrap fallback)
 *                              Replies with confirmation or parse error.
 *
 * Anything else is silently ignored.
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
import { TRIPWIRE_TELEGRAM_CHAT_ID } from "@/lib/harley-auth";
import { appendPunishment, isConfigured } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramChat = { id: number; type: string };
type TelegramFrom = { id: number; first_name?: string; username?: string };
type TelegramMessage = { chat?: TelegramChat; from?: TelegramFrom; text?: string };
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

function parseEnvChatId(name: string): number | null {
  const raw = process.env[name] || "";
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function isAuthorizedFineChat(chatId: number): boolean {
  if (chatId === TRIPWIRE_TELEGRAM_CHAT_ID) return true;
  const harley = parseEnvChatId("HARLEY_TELEGRAM_CHAT_ID");
  if (harley && chatId === harley) return true;
  const dan = parseEnvChatId("DAN_TELEGRAM_CHAT_ID");
  if (dan && chatId === dan) return true;
  return false;
}

/**
 * Parse "/fine 45 phone over 90min" → { amount: 45, reason: "phone over 90min" }.
 * Bot-username suffix on the command (`/fine@bot`) is stripped. Returns
 * null when the format doesn't match — caller replies with usage.
 */
function parseFineCommand(text: string): { amount: number; reason: string } | null {
  const m = text.match(/^\/fine(?:@\w+)?\s+(\S+)\s+(.+)$/i);
  if (!m) return null;
  const amount = Number(m[1].replace(/[$,]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const reason = m[2].trim();
  if (!reason) return null;
  return { amount, reason };
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

  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";

  // /start can be plain or namespaced as `/start@bot_username`.
  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    if (botToken) {
      await reply(botToken, chatId, `chat_id: ${chatId}`);
    } else {
      console.warn("[telegram webhook] TELEGRAM_BOT_TOKEN missing — skipping reply.");
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/fine" || text.startsWith("/fine ") || text.startsWith("/fine@")) {
    if (!isAuthorizedFineChat(chatId)) {
      // Stay quiet on unauthorized chats — don't leak that the command exists.
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    const parsed = parseFineCommand(text);
    if (!parsed) {
      if (botToken) {
        await reply(
          botToken,
          chatId,
          "Usage: /fine <amount> <reason>\nExample: /fine 45 phone over 90min"
        );
      }
      return NextResponse.json({ ok: true });
    }
    const fromName = message?.from?.first_name || message?.from?.username || "Telegram";
    try {
      await appendPunishment({
        amount: parsed.amount,
        reason: parsed.reason,
        setBy: `${fromName} (Telegram)`,
        ruleId: "",
      });
      if (botToken) {
        await reply(
          botToken,
          chatId,
          `✅ Fine logged: $${parsed.amount} — ${parsed.reason}`
        );
      }
    } catch (e) {
      console.error("[telegram webhook] /fine append failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to log fine. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
