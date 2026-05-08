/**
 * POST /api/notifications/auth-changed
 *
 * Tamper-evident tripwire. Fires a Telegram message to Harley whenever
 * `src/lib/harley-auth.ts` changes on main. Hit by the
 * notify-harley.yml GH Action — the workflow detects the auth-config
 * diff and POSTs commit metadata here. No-op if `harley-auth.ts`
 * wasn't touched in the push.
 *
 * Auth: Bearer ${CRON_SECRET} (same secret all GH Actions use).
 *
 * Body shape:
 *   {
 *     commit_sha: string,
 *     commit_short_sha: string,
 *     commit_msg: string,
 *     commit_author: string,
 *     commit_url: string
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { sendHarleyTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, error: reason }, { status: 401 });
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (provided !== secret) return unauthorized("bad cron secret");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const sha = String(body.commit_sha ?? "").trim();
  const shortSha = String(body.commit_short_sha ?? sha.slice(0, 8)).trim();
  const msg = String(body.commit_msg ?? "").trim();
  const author = String(body.commit_author ?? "").trim();
  const url = String(body.commit_url ?? "").trim();

  const text = [
    `⚠ AUTH CONFIG CHANGED on personal-dashboard`,
    `Author: ${author || "(unknown)"}`,
    `Commit: ${shortSha || "(no-sha)"}`,
    `Message: ${msg || "(empty)"}`,
    url ? `Link: ${url}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await sendHarleyTelegram(text);
  if (!result.sent) {
    return NextResponse.json(
      { ok: false, error: "telegram_failed", reason: result.reason },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, chatId: result.chatId, shortSha });
}
