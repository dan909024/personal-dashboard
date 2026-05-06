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

  // Sync a 3-day window so late-scored fields backfill on subsequent
  // runs (Whoop sometimes hasn't finished scoring "yesterday" at 8am
  // Sydney). For an explicit ?date=YYYY-MM-DD, we sync just that day.
  const explicit = req.nextUrl.searchParams.get("date");
  const targets = explicit
    ? [explicit]
    : [
        twoDaysAgoInSydney(),
        yesterdayInSydney(),
        todayInSydney(),
      ];

  const perDay: Array<{
    date: string;
    action?: "appended" | "updated";
    rowIndex?: number;
    values?: unknown;
    error?: string;
  }> = [];

  for (const target of targets) {
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
      perDay.push({
        date: target,
        action: result.action,
        rowIndex: result.rowIndex,
        values: rollup,
      });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[whoop-sync] ${target} failed:`, msg);
      perDay.push({ date: target, error: msg });
    }
  }

  const anyError = perDay.some((d) => d.error);
  return NextResponse.json(
    {
      ok: !anyError,
      targets,
      results: perDay,
    },
    { status: anyError ? 500 : 200 }
  );
}

function todayInSydney(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function twoDaysAgoInSydney(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const sydneyTodayStr = fmt.format(new Date());
  const sydneyToday = new Date(sydneyTodayStr + "T00:00:00Z");
  const d = new Date(sydneyToday.getTime() - 2 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
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
