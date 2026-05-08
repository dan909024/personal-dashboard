/**
 * Telegram fan-out helper.
 *
 * Two named senders, two channels:
 *   - sendHarleyTelegram(text) → Harley's DM (HARLEY_TELEGRAM_CHAT_ID env,
 *     fallback TRIPWIRE_TELEGRAM_CHAT_ID for bootstrap)
 *   - sendDanTelegram(text)    → Dan's DM (DAN_TELEGRAM_CHAT_ID env,
 *     fallback TRIPWIRE_TELEGRAM_CHAT_ID — also Dan during bootstrap)
 *
 * Used by the sync flows to push manual-asks reminders to Dan's
 * phone (so he sees "fire your iOS Shortcut" without staring at the
 * dashboard).
 *
 * Bot token in TELEGRAM_BOT_TOKEN. If missing, helpers log and return
 * { sent: false } without throwing — calling flows must never fail
 * because alerts aren't configured.
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

function danChatId(): number {
  const env = process.env.DAN_TELEGRAM_CHAT_ID || "";
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return TRIPWIRE_TELEGRAM_CHAT_ID;
}

async function postTelegram(chatId: number, text: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN missing — skipping send.");
    return { sent: false, reason: "TELEGRAM_BOT_TOKEN missing" };
  }
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

export async function sendHarleyTelegram(text: string): Promise<TelegramResult> {
  return postTelegram(harleyChatId(), text);
}

export async function sendDanTelegram(text: string): Promise<TelegramResult> {
  return postTelegram(danChatId(), text);
}

/**
 * Format the manual-asks reminder both sync flows push to Dan after
 * a sync fires. Plain text — Telegram renders newlines and emoji
 * natively; no Markdown needed.
 */
export function formatSyncManualAsksMessage(opts: {
  source: "dashboard" | "harley";
  whoop: "ok" | "error" | "not_connected" | "not_configured";
  whoopDetail?: string;
  manualAsks: string[];
}): string {
  const lines: string[] = [];
  const trigger = opts.source === "harley" ? "Harley triggered a sync" : "Sync triggered";
  lines.push(`🔄 ${trigger}`);
  lines.push("");
  if (opts.whoop === "ok") {
    lines.push(`Whoop: ✅ ${opts.whoopDetail || "synced"}`);
  } else {
    lines.push(`Whoop: ⚠️ ${opts.whoop}${opts.whoopDetail ? ` — ${opts.whoopDetail}` : ""}`);
  }
  if (opts.manualAsks.length > 0) {
    lines.push("");
    lines.push("Manual asks (fire on your devices):");
    for (const a of opts.manualAsks) lines.push(`• ${a}`);
  }
  return lines.join("\n");
}
