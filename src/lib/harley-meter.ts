/**
 * Harley Meter — composite score (0-100) over a rolling 7-day window.
 *
 * Five equally-weighted inputs:
 *   1. Wake by 06:30          (Whoop Daily wake time)
 *   2. Bed by 22:30           (Whoop Daily sleep onset)
 *   3. Gym 4+ /week           (Whoop Workouts count)
 *   4. 70k steps /week        (Apple Health steps)
 *   5. 3.3 L water /day avg   (Apple Health waterMl)
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
  getWhoopWorkoutsInRange,
  isConfigured,
  todaySydneyISO,
} from "./sheets";

export const WAKE_BY_MIN = 6 * 60 + 30;       // 06:30
export const BED_BY_MIN = 22 * 60 + 30;       // 22:30
export const GYM_TARGET_PER_WEEK = 4;
export const STEPS_TARGET_PER_WEEK = 70_000;
export const WATER_TARGET_ML_PER_DAY = 3_300;
/** Whoop daily strain floor on a training day (0–21 scale). */
export const STRAIN_TARGET_TRAINING_DAY = 12;
/** Whoop strain top-of-scale, used by the calculator's “/21” display. */
export const STRAIN_MAX = 21;
/** A workout day counts as a "training day" once it crosses this minute mark. */
export const TRAINING_DAY_MIN_DURATION_MIN = 30;
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

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(iso + "T12:00:00Z") + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Strain score over the rolling 7-day window:
 *   training-days that hit ≥12 strain / total training-days with strain data
 * "Training day" = any Whoop workout ≥30 min on that calendar day.
 *
 * Returns 1 (vacuous "passed") when there were no training days — the gym
 * rule already penalizes a workout-less week, so failing strain too would
 * double-count.
 */
async function strainInput(): Promise<number> {
  const today = todaySydneyISO();
  const start = addDaysISO(today, -(WINDOW_DAYS - 1));
  const [dailies, workouts] = await Promise.all([
    getRecentWhoopDaily(WINDOW_DAYS),
    getWhoopWorkoutsInRange(start, today),
  ]);
  const trainingDays = new Set<string>();
  for (const w of workouts) {
    if (w.durationMin >= TRAINING_DAY_MIN_DURATION_MIN) trainingDays.add(w.date);
  }
  if (trainingDays.size === 0) return 1;
  const strainByDate = new Map<string, number>();
  for (const r of dailies) {
    const n = Number(r.strain);
    if (Number.isFinite(n)) strainByDate.set(r.date, n);
  }
  let met = 0;
  let total = 0;
  for (const date of trainingDays) {
    const s = strainByDate.get(date);
    if (typeof s !== "number") continue;
    total++;
    if (s >= STRAIN_TARGET_TRAINING_DAY) met++;
  }
  if (total === 0) return 1;
  return met / total;
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

export const getHarleyMeter = unstable_cache(
  async (): Promise<number> => {
    if (!isConfigured()) return 0;
    const inputs = await Promise.all([
      wakeInput(),
      bedInput(),
      gymInput(),
      stepsInput(),
      waterInput(),
    ]);
    const avg = inputs.reduce((s, v) => s + v, 0) / inputs.length;
    return Math.round(avg * 100);
  },
  ["dashboard:harley-meter"],
  { revalidate: 30 }
);

export type HarleyRuleStatus = {
  id: "wake" | "bed" | "gym" | "steps" | "water" | "strain";
  label: string;
  /** 0..1 input score (same number that feeds the meter average). */
  score: number;
  /**
   * Bucket: "met" (≥0.9), "at-risk" (0.5..0.9), "failed" (<0.5).
   * The Goddess panel renders these with different colors.
   */
  state: "met" | "at-risk" | "failed";
};

function bucket(score: number): HarleyRuleStatus["state"] {
  if (score >= 0.9) return "met";
  if (score >= 0.5) return "at-risk";
  return "failed";
}

/**
 * Per-rule breakdown for the Goddess panel "at-risk rules" card. Strain
 * is included in the breakdown but intentionally NOT in `getHarleyMeter`'s
 * 5-input average — adding a 6th input would silently rebalance the
 * existing meter score. Strain fines via rule-eval; the breakdown only
 * surfaces last-7-day status and powers the prefill UX.
 */
export const getHarleyMeterDetail = unstable_cache(
  async (): Promise<HarleyRuleStatus[]> => {
    if (!isConfigured()) return [];
    const [wake, bed, gym, steps, water, strain] = await Promise.all([
      wakeInput(),
      bedInput(),
      gymInput(),
      stepsInput(),
      waterInput(),
      strainInput(),
    ]);
    return [
      { id: "wake", label: "Wake by 06:30", score: wake, state: bucket(wake) },
      { id: "bed", label: "Bed by 22:30", score: bed, state: bucket(bed) },
      { id: "gym", label: "Gym 4+/week", score: gym, state: bucket(gym) },
      { id: "steps", label: "70k steps/week", score: steps, state: bucket(steps) },
      { id: "water", label: "3.3 L water/day", score: water, state: bucket(water) },
      { id: "strain", label: "Strain ≥12 on training days", score: strain, state: bucket(strain) },
    ];
  },
  ["dashboard:harley-meter-detail"],
  { revalidate: 30 }
);

/**
 * Per-day strain progress for the current Mon–Sun week, used by the
 * Goddess panel's "Whoop strain target" calculator. Surfaces the target
 * (≥12 / 21), the gym weekly target as the count of training days
 * needed, and which days have already hit / missed.
 */
export type StrainWeekProgress = {
  target: number;
  max: number;
  trainingDaysRequired: number;
  weekStart: string;
  weekEnd: string;
  todayISO: string;
  /** Training-days this week with strain ≥ target. */
  trainingDaysHit: number;
  /** Training-days this week with strain < target (he's already failed these). */
  trainingDaysMissed: number;
  /** Calendar days remaining including today. */
  daysRemaining: number;
  byDay: Array<{
    date: string;
    /** 0=Mon..6=Sun. */
    dow: number;
    strain: number | null;
    isTrainingDay: boolean;
    /** null when not a training day yet. */
    hitTarget: boolean | null;
    isToday: boolean;
    isFuture: boolean;
  }>;
};

/** Sydney-local Monday for the week containing the given YYYY-MM-DD. */
function mondayOfSydneyWeek(iso: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    weekday: "short",
  });
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    fmt.format(new Date(iso + "T12:00:00Z"))
  );
  const back = dow === 0 ? 6 : dow - 1;
  return addDaysISO(iso, -back);
}

export const getStrainWeekProgress = unstable_cache(
  async (): Promise<StrainWeekProgress> => {
    const today = todaySydneyISO();
    const weekStart = mondayOfSydneyWeek(today);
    const weekEnd = addDaysISO(weekStart, 6);
    const empty: StrainWeekProgress = {
      target: STRAIN_TARGET_TRAINING_DAY,
      max: STRAIN_MAX,
      trainingDaysRequired: GYM_TARGET_PER_WEEK,
      weekStart,
      weekEnd,
      todayISO: today,
      trainingDaysHit: 0,
      trainingDaysMissed: 0,
      daysRemaining: 0,
      byDay: [],
    };
    if (!isConfigured()) return empty;

    const [dailies, workouts] = await Promise.all([
      getRecentWhoopDaily(8),
      getWhoopWorkoutsInRange(weekStart, weekEnd),
    ]);

    const strainByDate = new Map<string, number>();
    for (const r of dailies) {
      if (r.date < weekStart || r.date > weekEnd) continue;
      const n = Number(r.strain);
      if (Number.isFinite(n)) strainByDate.set(r.date, n);
    }
    const trainingDates = new Set<string>();
    for (const w of workouts) {
      if (w.durationMin >= TRAINING_DAY_MIN_DURATION_MIN) trainingDates.add(w.date);
    }

    const byDay: StrainWeekProgress["byDay"] = [];
    let trainingDaysHit = 0;
    let trainingDaysMissed = 0;
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(weekStart, i);
      const strain = strainByDate.has(date) ? (strainByDate.get(date) as number) : null;
      const isTrainingDay = trainingDates.has(date);
      let hitTarget: boolean | null = null;
      if (isTrainingDay && typeof strain === "number") {
        hitTarget = strain >= STRAIN_TARGET_TRAINING_DAY;
        if (hitTarget) trainingDaysHit++;
        else trainingDaysMissed++;
      }
      byDay.push({
        date,
        dow: i,
        strain,
        isTrainingDay,
        hitTarget,
        isToday: date === today,
        isFuture: date > today,
      });
    }

    const daysRemaining = byDay.filter((d) => d.date >= today).length;

    return {
      target: STRAIN_TARGET_TRAINING_DAY,
      max: STRAIN_MAX,
      trainingDaysRequired: GYM_TARGET_PER_WEEK,
      weekStart,
      weekEnd,
      todayISO: today,
      trainingDaysHit,
      trainingDaysMissed,
      daysRemaining,
      byDay,
    };
  },
  ["dashboard:strain-week-progress"],
  { revalidate: 60 }
);
