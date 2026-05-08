/**
 * POST /api/telegram/webhook
 *
 * Inbound Telegram updates. Three flows handled:
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
 *   photo                    → if the SENDER is HARLEY_TELEGRAM_USER_ID
 *                              (falling back to HARLEY_TELEGRAM_CHAT_ID),
 *                              uploads the photo to Vercel Blob under
 *                              coach/<timestamp>.<ext>. Photos over 4.5MB
 *                              are dropped. No reply either way.
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
import { uploadCoachPhoto } from "@/lib/coach-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel function request body cap. Photos larger than this are silently
// ignored — Harley doesn't get a reply by design, so a "too big" message
// would just be confusing.
const MAX_PHOTO_BYTES = 4_500_000;

type TelegramChat = { id: number; type: string };
type TelegramFrom = { id: number; first_name?: string; username?: string };
type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};
type TelegramMessage = {
  chat?: TelegramChat;
  from?: TelegramFrom;
  text?: string;
  photo?: TelegramPhotoSize[];
};
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
  if (!chatId) return NextResponse.json({ ok: true });

  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";

  // Photo upload — Harley sends a picture, becomes the new dashboard coach
  // photo. Gated on the SENDER's user id, not the chat id, so it works
  // wherever the bot can see her photo (her DM with the bot today, a
  // shared group tomorrow). No confirmation reply by design.
  if (message?.photo && message.photo.length > 0) {
    await handleCoachPhoto(message.from?.id, message.photo, botToken);
    return NextResponse.json({ ok: true });
  }

  const text = (message?.text ?? "").trim();
  if (!text) return NextResponse.json({ ok: true });

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

/**
 * Handle a Telegram photo message: download from Telegram and upload to
 * Vercel Blob under `coach/<timestamp>.<ext>`. Gate is the SENDER's user
 * id (HARLEY_TELEGRAM_USER_ID, falling back to HARLEY_TELEGRAM_CHAT_ID
 * since chat id == user id in a private DM with the bot). Photos over
 * MAX_PHOTO_BYTES are dropped. No replies. Errors are logged + swallowed
 * so Telegram doesn't retry the webhook.
 */
async function handleCoachPhoto(
  fromUserId: number | undefined,
  photo: TelegramPhotoSize[],
  botToken: string
): Promise<void> {
  if (!fromUserId) return;
  const harley =
    parseEnvChatId("HARLEY_TELEGRAM_USER_ID") ??
    parseEnvChatId("HARLEY_TELEGRAM_CHAT_ID");
  if (!harley || fromUserId !== harley) return;
  if (!botToken) {
    console.warn("[telegram webhook] coach-photo: TELEGRAM_BOT_TOKEN missing");
    return;
  }

  // Telegram sends photo at multiple resolutions. Pick the largest by area.
  // file_size is the early bail signal — the user wants the run to abort
  // entirely (not even download) when the photo is over the cap.
  const largest = photo.reduce((a, b) =>
    a.width * a.height >= b.width * b.height ? a : b
  );
  if (largest.file_size && largest.file_size > MAX_PHOTO_BYTES) {
    console.log(
      `[telegram webhook] coach-photo: skipping ${largest.file_size}B over ${MAX_PHOTO_BYTES}B`
    );
    return;
  }

  try {
    // getFile returns { file_path, file_size }. Recheck size here in case
    // the photo array entry didn't carry it.
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(largest.file_id)}`
    );
    if (!fileRes.ok) {
      console.error("[telegram webhook] coach-photo: getFile failed", fileRes.status);
      return;
    }
    const fileBody = (await fileRes.json()) as {
      ok: boolean;
      result?: { file_path?: string; file_size?: number };
    };
    const filePath = fileBody.result?.file_path;
    const fileSize = fileBody.result?.file_size;
    if (!filePath) {
      console.error("[telegram webhook] coach-photo: no file_path in getFile response");
      return;
    }
    if (fileSize && fileSize > MAX_PHOTO_BYTES) {
      console.log(
        `[telegram webhook] coach-photo: getFile reports ${fileSize}B over ${MAX_PHOTO_BYTES}B — skipping`
      );
      return;
    }

    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`
    );
    if (!downloadRes.ok) {
      console.error(
        "[telegram webhook] coach-photo: download failed",
        downloadRes.status
      );
      return;
    }
    const bytes = await downloadRes.arrayBuffer();
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      console.log(
        `[telegram webhook] coach-photo: actual bytes ${bytes.byteLength} over ${MAX_PHOTO_BYTES} — skipping`
      );
      return;
    }

    // Telegram delivers JPEGs for photo messages. Honor the file extension
    // anyway in case that ever changes.
    const extMatch = filePath.match(/\.([a-z0-9]{2,4})$/i);
    const ext = extMatch ? extMatch[1] : "jpg";

    const url = await uploadCoachPhoto(bytes, ext);
    console.log("[telegram webhook] coach-photo: uploaded", url);
  } catch (e) {
    console.error("[telegram webhook] coach-photo failed:", (e as Error).message);
  }
}
