/**
 * POST /api/harley/purge-wrong-recipient
 *
 * One-off audit endpoint: marks Magic Links rows created in a given
 * time window as "wrong-recipient" so the audit trail stays intact
 * but the rows are visually flagged.
 *
 * Background: PR #38 set HARLEY_EMAIL = Daniel's avidcollective email
 * by mistake; any magic-link request issued during that window had
 * the email leg sent to the wrong address. The follow-up PR reverted
 * HARLEY_EMAIL to "" (Telegram-only). This endpoint marks the affected
 * rows so they're not mistaken for real history.
 *
 * Auth: same JWT cookie as /harley. Designed to be hit once after
 * deploy; idempotent — already-marked rows are skipped.
 *
 * Body (JSON):
 *   {
 *     "startMs": <number>,   // unix millis
 *     "endMs":   <number>,
 *     "note":    "wrong-recipient-purged-2026-05-07"
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyJWT } from "@/lib/jwt";
import { purgeMagicLinksInWindow, isConfigured } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorized(): Promise<boolean> {
  const c = await cookies();
  const cookie = c.get("harley_session");
  if (!cookie) return false;
  const secret = process.env.HARLEY_JWT_SECRET || "";
  if (!secret) return false;
  const v = verifyJWT(cookie.value, secret);
  return v.ok && v.payload.sub === "harley";
}

const MAX_NOTE_LEN = 200;

export async function POST(req: NextRequest) {
  if (!(await authorized())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isConfigured()) {
    return NextResponse.json({ error: "sheets not configured" }, { status: 500 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const obj = body as { startMs?: unknown; endMs?: unknown; note?: unknown };
  const startMs = Number(obj.startMs);
  const endMs = Number(obj.endMs);
  const note = String(obj.note ?? "").trim().slice(0, MAX_NOTE_LEN);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return NextResponse.json({ error: "bad_window" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "bad_note" }, { status: 400 });
  }
  try {
    const result = await purgeMagicLinksInWindow({ startMs, endMs, note });
    return NextResponse.json({
      ok: true,
      window: {
        startMs,
        endMs,
        startISO: new Date(startMs).toISOString(),
        endISO: new Date(endMs).toISOString(),
      },
      note,
      ...result,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[purge-wrong-recipient] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
