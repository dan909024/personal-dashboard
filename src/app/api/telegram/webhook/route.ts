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
import { uploadCoachPhoto } from "@/lib/coach-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel function request body cap. Photos larger than this are silently
// ignored — Harley doesn't get a reply by design, so a "too big" message
// would just be confusing.
const MAX_PHOTO_BYTES = 4_500_000;

type TelegramChat = { id: number; type: string };
type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};
type TelegramMessage = {
  chat?: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
};
type TelegramUpdate = {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

function parseEnvChatId(name: string): number | null {
  const raw = process.env[name] || "";
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

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
  if (!chatId) return NextResponse.json({ ok: true });

  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";

  // Photo upload — Harley sends a picture, becomes the new dashboard coach
  // photo. No confirmation reply (per product decision). Silently dropped
  // for non-Harley chats, photos over MAX_PHOTO_BYTES, or Blob errors.
  if (message?.photo && message.photo.length > 0) {
    await handleCoachPhoto(chatId, message.photo, botToken);
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
  }

  return NextResponse.json({ ok: true });
}

/**
 * Handle a Telegram photo message: download from Telegram and upload to
 * Vercel Blob under `coach/<timestamp>.<ext>`. Strict — only Harley's chat
 * id, only photos under MAX_PHOTO_BYTES, no replies. Errors are logged
 * and swallowed so Telegram doesn't retry the webhook.
 */
async function handleCoachPhoto(
  chatId: number,
  photo: TelegramPhotoSize[],
  botToken: string
): Promise<void> {
  const harley = parseEnvChatId("HARLEY_TELEGRAM_CHAT_ID");
  if (!harley || chatId !== harley) return;
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
