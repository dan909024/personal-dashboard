/**
 * Whoop sync core. Extracted so the cron route at
 * /api/cron/whoop-sync and the on-demand /api/sync/trigger can share
 * the same logic without an internal HTTP hop or copy-paste.
 *
 * Each call walks a 3-day window in Sydney TZ (today, yesterday, day
 * before) so late-scored fields backfill on subsequent runs. Per-day
 * failures are caught and surfaced in the result rather than crashing
 * the whole sync.
 */
import { getDailyRollup, getWorkouts, type WorkoutItem } from "@/lib/whoop";
import {
  upsertWhoopDaily,
  appendWhoopWorkout,
  whoopWorkoutIdExists,
  getWhoopTokens,
  isConfigured,
} from "@/lib/sheets";

export type WhoopSyncDayResult = {
  date: string;
  action?: "appended" | "updated";
  rowIndex?: number;
  values?: unknown;
  workouts?: { fetched: number; appended: number; error?: string };
  error?: string;
};

export type WhoopSyncResult =
  | { ok: true; targets: string[]; results: WhoopSyncDayResult[] }
  | { ok: false; reason: "not_configured" | "not_connected"; targets: string[]; results: WhoopSyncDayResult[] }
  | { ok: false; reason: "partial"; targets: string[]; results: WhoopSyncDayResult[] };

export async function runWhoopSync(opts: { date?: string } = {}): Promise<WhoopSyncResult> {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", targets: [], results: [] };
  }
  const tokens = await getWhoopTokens();
  if (!tokens) {
    return { ok: false, reason: "not_connected", targets: [], results: [] };
  }

  const targets = opts.date
    ? [opts.date]
    : [twoDaysAgoInSydney(), yesterdayInSydney(), todayInSydney()];

  const results: WhoopSyncDayResult[] = [];
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
      const workouts = await syncWorkouts(target).catch((e) => ({
        fetched: 0,
        appended: 0,
        error: (e as Error).message,
      }));
      results.push({
        date: target,
        action: result.action,
        rowIndex: result.rowIndex,
        values: rollup,
        workouts,
      });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[whoop-sync] ${target} failed:`, msg);
      results.push({ date: target, error: msg });
    }
  }

  const anyError = results.some((d) => d.error);
  if (anyError) return { ok: false, reason: "partial", targets, results };
  return { ok: true, targets, results };
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

function todayInSydney(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function yesterdayInSydney(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const sydneyTodayStr = fmt.format(new Date());
  const sydneyToday = new Date(sydneyTodayStr + "T00:00:00Z");
  const yest = new Date(sydneyToday.getTime() - 24 * 3600 * 1000);
  return yest.toISOString().slice(0, 10);
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
