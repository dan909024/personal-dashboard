/**
 * Screen Time UI scraper trigger mailbox.
 *
 * - POST (server-side, no client auth): writes "fire ASAP" timestamp
 *   to the Screen Time Control kv tab. Called from the
 *   /screentime page's Refresh button via a server action — the
 *   server action is the auth boundary, so this route is meant to
 *   be reachable without explicit Bearer auth (Vercel deployment
 *   protection or page-level controls own that). Still requires
 *   SCREENTIME_INGEST_SECRET to be configured server-side, to keep
 *   the surface area honest.
 *
 * - GET (Bearer auth via SCREENTIME_INGEST_SECRET): returns the
 *   current trigger timestamp. Polled by scripts/screentime-ui-sync.ts
 *   at the start of each launchd invocation; if the timestamp is
 *   recent (and newer than the script's last successful scrape),
 *   the script bypasses its idle / cooldown gates.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getScreentimeForceTrigger,
  setScreentimeForceTriggerNow,
  isConfigured,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const expected = process.env.SCREENTIME_INGEST_SECRET || "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "SCREENTIME_INGEST_SECRET not configured" },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "bad_secret" }, { status: 401 });
  }
  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "sheets_not_configured" },
      { status: 500 }
    );
  }
  try {
    const value = await getScreentimeForceTrigger();
    return NextResponse.json({ ok: true, force_trigger_at: value });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function POST() {
  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "sheets_not_configured" },
      { status: 500 }
    );
  }
  try {
    const value = await setScreentimeForceTriggerNow();
    return NextResponse.json({ ok: true, force_trigger_at: value });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
