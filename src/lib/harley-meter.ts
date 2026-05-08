/**
 * Harley Meter — composite score (0-100) over a rolling 7-day window.
 *
 * Six equally-weighted inputs:
 *   1. Wake by 06:30          (Whoop Daily wake time)
 *   2. Bed by 22:30           (Whoop Daily sleep onset)
 *   3. Gym 4+ /week           (Whoop Workouts count)
 *   4. 70k steps /week        (Apple Health steps)
 *   5. 3.3 L water /day avg   (Apple Health waterMl)
 *   6. Harley calendar tasks  (4/week target; past Harley-authored events
 *                              still on the calendar are treated as done —
 *                              deletion = task withdrawn, not failed)
 *
 * Each input contributes 0..1; the meter is the average × 100.
 *
 * Replaces the old hand-edited "Harley Meter" column in Daily Log.
 */
import { unstable_cache } from "next/cache";
import {
  getRecentWhoopDaily,
  getRecentAppleHealth,
  getDashboardWhoopWorkouts,
  isConfigured,
} from "./sheets";
import { getHarleyTaskWindow, isCalendarConfigured } from "./calendar";

export const WAKE_BY_MIN = 6 * 60 + 30;       // 06:30
export const BED_BY_MIN = 22 * 60 + 30;       // 22:30
export const GYM_TARGET_PER_WEEK = 4;
export const STEPS_TARGET_PER_WEEK = 70_000;
export const WATER_TARGET_ML_PER_DAY = 3_300;
export const HARLEY_TASK_TARGET_PER_WEEK = 4;
export const WINDOW_DAYS = 7;

/**
 * Parse "HH:MM" / "H:MM" to minutes-since-midnight. Returns null on
 * empty or unparseable.
 */
function clockToMin(raw: string): number | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

/**
 * Sleep onset time. The Whoop "bedTime" column stores the *start* of
 * the sleep block in Sydney local time. If Daniel went to bed at 23:30
 * the value is "23:30"; if at 00:30 the next morning, "00:30". We treat
 * 00:00–05:59 as "next-day" by adding 24h so the comparison against the
 * 22:30 cutoff stays meaningful (00:30 = 1470 min, > 1350 = fail).
 */
function bedTimeToMin(raw: string): number | null {
  const min = clockToMin(raw);
  if (min === null) return null;
  if (min < 6 * 60) return min + 24 * 60;
  return min;
}

async function wakeInput(): Promise<number> {
  const rows = await getRecentWhoopDaily(WINDOW_DAYS);
  if (rows.length === 0) return 0;
  let met = 0;
  let total = 0;
  for (const r of rows) {
    const min = clockToMin(r.wakeTime);
    if (min === null) continue;
    total++;
    if (min <= WAKE_BY_MIN) met++;
  }
  if (total === 0) return 0;
  return met / total;
}

async function bedInput(): Promise<number> {
  const rows = await getRecentWhoopDaily(WINDOW_DAYS);
  if (rows.length === 0) return 0;
  let met = 0;
  let total = 0;
  for (const r of rows) {
    const min = bedTimeToMin(r.bedTime);
    if (min === null) continue;
    total++;
    if (min <= BED_BY_MIN) met++;
  }
  if (total === 0) return 0;
  return met / total;
}

async function gymInput(): Promise<number> {
  const w = await getDashboardWhoopWorkouts();
  return Math.min(w.weekWorkoutCount / GYM_TARGET_PER_WEEK, 1);
}

async function stepsInput(): Promise<number> {
  const rows = await getRecentAppleHealth(WINDOW_DAYS);
  if (rows.length === 0) return 0;
  const total = rows.reduce((sum, r) => sum + (r.steps || 0), 0);
  return Math.min(total / STEPS_TARGET_PER_WEEK, 1);
}

async function waterInput(): Promise<number> {
  const rows = await getRecentAppleHealth(WINDOW_DAYS);
  if (rows.length === 0) return 0;
  const withWater = rows.filter((r) => typeof r.waterMl === "number" && r.waterMl > 0);
  if (withWater.length === 0) return 0;
  const totalMl = withWater.reduce((sum, r) => sum + (r.waterMl || 0), 0);
  const avgMl = totalMl / withWater.length;
  return Math.min(avgMl / WATER_TARGET_ML_PER_DAY, 1);
}

async function harleyTasksInput(): Promise<number> {
  if (!isCalendarConfigured()) return 0;
  const { past } = await getHarleyTaskWindow();
  // Past Harley events still on the calendar count as done (deletion =
  // withdrawn). Score = pace toward HARLEY_TASK_TARGET_PER_WEEK.
  return Math.min(past.length / HARLEY_TASK_TARGET_PER_WEEK, 1);
}

export const getHarleyMeter = unstable_cache(
  async (): Promise<number> => {
    if (!isConfigured()) return 0;
    const inputs = await Promise.all([
      wakeInput(),
      bedInput(),
      gymInput(),
      stepsInput(),
      waterInput(),
      harleyTasksInput(),
    ]);
    const avg = inputs.reduce((s, v) => s + v, 0) / inputs.length;
    return Math.round(avg * 100);
  },
  ["dashboard:harley-meter"],
  { revalidate: 30 }
);
