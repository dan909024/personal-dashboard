/**
 * POST /api/harley/login-request
 *
 * Issues a one-time magic link, persists it in the "Magic Links" tab,
 * and delivers the URL via two channels in parallel:
 *
 *   1. PRIMARY — Resend email to HARLEY_EMAIL (source-hardcoded in
 *      src/lib/harley-auth.ts).
 *   2. TRIPWIRE — Telegram bot DM to TRIPWIRE_TELEGRAM_CHAT_ID, a
 *      private channel Harley controls. One-way audit fan-out: the
 *      bot has no other purpose. Anything in that channel that Harley
 *      didn't request is the breach signal.
 *
 * Tolerant of partial failure: as long as ONE channel delivered, the
 * request returns 200. Both channels failing returns 502. Every step
 * (request, send_*, send_failed_*, rate_limit_hit) appends a forensic
 * row to "Magic Link Audit".
 *
 * Rate limit: 3 per hour, 10 per day, per IP.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { HARLEY_EMAIL, TRIPWIRE_TELEGRAM_CHAT_ID } from "@/lib/harley-auth";
import { sendEmail } from "@/lib/email";
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

async function postTelegramTripwire(
  botToken: string,
  chatId: number,
  text: string
): Promise<{ ok: boolean; status: number; reason?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    const reason = (e as Error).message;
    console.error("[login-request] tripwire fetch threw:", reason);
    return { ok: false, status: 0, reason };
  }
}

export async function POST(req: NextRequest) {
  if (!isConfigured()) {
    return NextResponse.json({ error: "sheets not configured" }, { status: 500 });
  }
  if (!HARLEY_EMAIL) {
    return NextResponse.json(
      { error: "HARLEY_EMAIL not bootstrapped in src/lib/harley-auth.ts" },
      { status: 503 }
    );
  }

  const ip = clientIp(req);
  const now = Date.now();

  // Rate limit
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

  // Generate + persist token
  const token = randomBytes(16).toString("hex");
  const expiresAt = new Date(now + TTL_MS).toISOString();
  await appendMagicLink(token, expiresAt, ip);
  await appendMagicLinkAudit(ip, "request", "");

  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host") || "";
  const verifyUrl = `${proto}://${host}/harley/verify?t=${token}`;
  const isoTime = new Date(now).toISOString();
  const subject = "Goddess control panel — access link";
  const text = `Access link requested at ${isoTime} from IP ${ip}.\n\n${verifyUrl}\n\nLink expires in 15 minutes. One-time use.`;
  const html = `<p>Access link requested at ${isoTime} from IP ${ip}.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>Link expires in 15 minutes. One-time use.</p>`;
  const tripwireText = `Access link requested at ${isoTime} from IP ${ip}: ${verifyUrl}`;

  // PRIMARY: email via Resend.
  const emailRes = await sendEmail(HARLEY_EMAIL, subject, html, text);
  await appendMagicLinkAudit(
    ip,
    emailRes.sent ? "sent_email" : "send_failed_email",
    emailRes.sent ? "" : emailRes.reason
  );

  // PARALLEL: Telegram tripwire. Failures are logged but don't block
  // delivery if email succeeded.
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  let tripwireOk = false;
  if (!botToken) {
    await appendMagicLinkAudit(ip, "send_failed_tripwire", "TELEGRAM_BOT_TOKEN missing");
  } else if (TRIPWIRE_TELEGRAM_CHAT_ID === 0) {
    await appendMagicLinkAudit(ip, "send_failed_tripwire", "chat_id not bootstrapped");
  } else {
    const tg = await postTelegramTripwire(botToken, TRIPWIRE_TELEGRAM_CHAT_ID, tripwireText);
    tripwireOk = tg.ok;
    await appendMagicLinkAudit(
      ip,
      tg.ok ? "sent_tripwire" : "send_failed_tripwire",
      tg.ok ? "" : tg.reason ?? `status=${tg.status}`
    );
  }

  // Tolerant: at least one channel must have delivered.
  if (!emailRes.sent && !tripwireOk) {
    return NextResponse.json({ error: "all sends failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
