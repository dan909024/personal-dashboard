/**
 * POST /api/harley/login-request
 *
 * Issues a one-time magic link, persists it in the "Magic Links" tab,
 * and sends the URL via Telegram bot DM to BOTH HARLEY_CHAT_ID and
 * TRIPWIRE_CHAT_ID. Tripwire fan-out is what makes this tamper-evident —
 * any login attempt is visible to a separate audit recipient.
 *
 * Rate limit: 3 per hour, 10 per day, per IP, persisted in
 * "Magic Link Audit". Each request, send, and rate-limit hit logs a
 * forensic row.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { HARLEY_CHAT_ID, TRIPWIRE_CHAT_ID } from "@/lib/harley-auth";
import {
  appendMagicLink,
  appendMagicLinkAudit,
  countMagicLinkRequests,
  isConfigured,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR_LIMIT = 3;
const DAY_LIMIT = 10;
const TTL_MS = 15 * 60 * 1000;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || "unknown";
}

async function sendTelegram(
  botToken: string,
  chatId: number,
  text: string
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error("[login-request] telegram send threw:", (e as Error).message);
    return { ok: false, status: 0 };
  }
}

export async function POST(req: NextRequest) {
  if (!isConfigured()) {
    return NextResponse.json({ error: "sheets not configured" }, { status: 500 });
  }
  const ip = clientIp(req);
  const now = Date.now();

  const hourCount = await countMagicLinkRequests(ip, now - 3_600_000);
  if (hourCount >= HOUR_LIMIT) {
    await appendMagicLinkAudit(ip, "rate_limit_hit", "hour");
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const dayCount = await countMagicLinkRequests(ip, now - 86_400_000);
  if (dayCount >= DAY_LIMIT) {
    await appendMagicLinkAudit(ip, "rate_limit_hit", "day");
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!botToken) {
    await appendMagicLinkAudit(ip, "send_skipped", "TELEGRAM_BOT_TOKEN missing");
    return NextResponse.json({ error: "telegram not configured" }, { status: 500 });
  }
  if (HARLEY_CHAT_ID === 0 || TRIPWIRE_CHAT_ID === 0) {
    await appendMagicLinkAudit(ip, "send_skipped", "chat_ids not bootstrapped");
    return NextResponse.json(
      { error: "auth identities not bootstrapped" },
      { status: 503 }
    );
  }

  const token = randomBytes(16).toString("hex"); // 32 hex chars
  const expiresAt = new Date(now + TTL_MS).toISOString();
  await appendMagicLink(token, expiresAt, ip);
  await appendMagicLinkAudit(ip, "request", "");

  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host") || "";
  const verifyUrl = `${proto}://${host}/harley/verify?t=${token}`;
  const isoTime = new Date(now).toISOString();
  const text = `Access link requested at ${isoTime} from IP ${ip}: ${verifyUrl}`;

  const [harleyRes, tripwireRes] = await Promise.all([
    sendTelegram(botToken, HARLEY_CHAT_ID, text),
    sendTelegram(botToken, TRIPWIRE_CHAT_ID, text),
  ]);
  await appendMagicLinkAudit(
    ip,
    harleyRes.ok ? "sent_harley" : "send_failed_harley",
    harleyRes.ok ? "" : `status=${harleyRes.status}`
  );
  await appendMagicLinkAudit(
    ip,
    tripwireRes.ok ? "sent_tripwire" : "send_failed_tripwire",
    tripwireRes.ok ? "" : `status=${tripwireRes.status}`
  );

  if (!harleyRes.ok && !tripwireRes.ok) {
    return NextResponse.json({ error: "telegram send failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
