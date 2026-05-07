/**
 * Daily Whoop sync. Scheduled at 22:00 UTC = 8am AEST so yesterday's
 * data has settled. Vercel adds an Authorization header with the
 * CRON_SECRET when it triggers the cron, which we verify here.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDailyRollup, getWorkouts, type WorkoutItem } from "@/lib/whoop";
import {
  upsertWhoopDaily,
  appendWhoopWorkout,
  whoopWorkoutIdExists,
  getWhoopTokens,
  isConfigured,
} from "@/lib/sheets";

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
    workouts?: { fetched: number; appended: number; error?: string };
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
      // Append new workouts for this target day. A workout fetch failure
      // doesn't fail the daily — surface counts in the response.
      const workouts = await syncWorkouts(target).catch((e) => ({
        fetched: 0,
        appended: 0,
        error: (e as Error).message,
      }));
      perDay.push({
        date: target,
        action: result.action,
        rowIndex: result.rowIndex,
        values: rollup,
        workouts,
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

async function syncWorkouts(
  target: string
): Promise<{ fetched: number; appended: number; error?: string }> {
  let workouts: WorkoutItem[];
  try {
    workouts = await getWorkouts(target);
  } catch (e) {
    const msg = (e as Error).message;
    console.warn("[whoop-sync] getWorkouts failed:", msg);
    return { fetched: 0, appended: 0, error: msg };
  }
  // TEMP DIAGNOSTIC: log raw workouts so we can see whether the endpoint
  // returns nothing or returns items that the skip-pending logic filters.
  console.warn(
    `[whoop-sync] raw response: date=${target} workouts=${JSON.stringify(workouts)}`
  );
  let appended = 0;
  for (const w of workouts) {
    const id = String(w.id);
    if (!id) continue;
    if (await whoopWorkoutIdExists(id)) continue;
    const startMs = Date.parse(w.start);
    const endMs = Date.parse(w.end);
    const durationMin =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0, Math.round((endMs - startMs) / 60000))
        : 0;
    const date = sydneyDateOf(w.start) || target;
    await appendWhoopWorkout({
      date,
      workoutId: id,
      sportId: typeof w.sport_id === "number" ? w.sport_id : null,
      strain: typeof w.score?.strain === "number" ? w.score.strain : null,
      durationMin,
      avgHr: typeof w.score?.average_heart_rate === "number" ? w.score.average_heart_rate : null,
      maxHr: typeof w.score?.max_heart_rate === "number" ? w.score.max_heart_rate : null,
      kilojoules: typeof w.score?.kilojoule === "number" ? w.score.kilojoule : null,
      start: w.start,
      end: w.end,
      syncedAt: new Date().toISOString(),
    });
    appended++;
  }
  return { fetched: workouts.length, appended };
}

function sydneyDateOf(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
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
