/**
 * Daily Whoop sync. Scheduled at 22:00 UTC = 8am AEST so yesterday's
 * data has settled. Vercel adds an Authorization header with the
 * CRON_SECRET when it triggers the cron, which we verify here.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDailyRollup } from "@/lib/whoop";
import { upsertWhoopDaily, getWhoopTokens, isConfigured } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, error: reason }, { status: 401 });
}

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
    return unauthorized("bad cron secret");
  }

  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Sheets not configured" },
      { status: 500 }
    );
  }

  const tokens = await getWhoopTokens();
  if (!tokens) {
    return NextResponse.json(
      {
        ok: false,
        error: "Whoop not connected. Visit /api/whoop/connect first.",
      },
      { status: 400 }
    );
  }

  // Yesterday in Australia/Sydney — that's the day whose Whoop data is
  // ready by 8am local. We compute the date string directly to avoid
  // tz/DST traps when running at the boundary.
  const target = req.nextUrl.searchParams.get("date") || yesterdayInSydney();

  try {
    const rollup = await getDailyRollup(target);
    const result = await upsertWhoopDaily({
      date: rollup.date,
      recovery: rollup.recovery,
      strain: rollup.strain,
      sleepHours: rollup.sleepHours,
      wakeTime: rollup.wakeTime,
      bedTime: rollup.bedTime,
      rhr: rollup.rhr,
      hrv: rollup.hrv,
    });
    return NextResponse.json({
      ok: true,
      action: result.action,
      rowIndex: result.rowIndex,
      date: target,
      values: rollup,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[whoop-sync] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

function yesterdayInSydney(): string {
  // Get current Sydney date-parts, subtract a day.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = new Date();
  const sydneyTodayStr = fmt.format(today); // YYYY-MM-DD
  const sydneyToday = new Date(sydneyTodayStr + "T00:00:00Z");
  const yest = new Date(sydneyToday.getTime() - 24 * 3600 * 1000);
  return yest.toISOString().slice(0, 10);
}
