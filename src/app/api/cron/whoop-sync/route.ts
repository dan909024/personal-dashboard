/**
 * Daily Whoop sync. Scheduled at 22:00 UTC = 8am AEST so yesterday's
 * data has settled. Vercel adds an Authorization header with the
 * CRON_SECRET when it triggers the cron, which we verify here.
 *
 * The actual sync logic lives in @/lib/whoop-sync so /api/sync/trigger
 * (Harley's on-demand button) can share it.
 */
import { NextRequest, NextResponse } from "next/server";
import { runWhoopSync } from "@/lib/whoop-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured on server" },
      { status: 500 }
    );
  }
  // Vercel cron sends "Authorization: Bearer ${CRON_SECRET}". We also
  // accept a `?secret=` query param for manual testing.
  const auth = req.headers.get("authorization") || "";
  const queryParam = new URL(req.url).searchParams.get("secret") || "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : queryParam;
  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: "bad cron secret" }, { status: 401 });
  }

  const explicit = req.nextUrl.searchParams.get("date") || undefined;
  const result = await runWhoopSync({ date: explicit });

  if (!result.ok && result.reason === "not_configured") {
    return NextResponse.json({ ok: false, error: "Sheets not configured" }, { status: 500 });
  }
  if (!result.ok && result.reason === "not_connected") {
    return NextResponse.json(
      { ok: false, error: "Whoop not connected. Visit /api/whoop/connect first." },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { ok: result.ok, targets: result.targets, results: result.results },
    { status: result.ok ? 200 : 500 }
  );
}
