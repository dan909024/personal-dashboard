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
  getRecentEdgeLog,
  getRecentScreentime,
  getRecentWorshipLog,
  getDashboardWhoopWorkouts,
  getSetting,
  isConfigured,
  type ScreenTimeRow,
} from "./sheets";
import {
  dedupeAppsPreferMac,
  displayAppName,
  dropCategoryRows,
  dropMacNonBundleIdLabels,
} from "./screentime-display";

export const WAKE_BY_MIN = 6 * 60 + 30;       // 06:30
export const BED_BY_MIN = 22 * 60 + 30;       // 22:30
export const GYM_TARGET_PER_WEEK = 4;
export const STEPS_TARGET_PER_WEEK = 70_000;
export const WATER_TARGET_ML_PER_DAY = 3_300;
export const WINDOW_DAYS = 7;

/* ---------- thresholds shared with rule-eval ---------- */

/** Obsidian bundle id used for writing-rule scoring. */
export const WRITING_BUNDLE_ID = "md.obsidian";
/** Default weekly writing-hours target (overridable via `writing_target_hr_per_week`). */
export const WRITING_TARGET_HR_DEFAULT = 8;
/**
 * Daily Screen Time buckets fined when over target. Mirrors the dashboard
 * SCREENTIME tile's buckets but is a separate copy so the fineable thresholds
 * can drift from the display tile if needed.
 */
export const SCREENTIME_BUCKETS: Array<{ label: string; apps: Set<string>; targetMin: number }> = [
  { label: "YouTube", apps: new Set(["YouTube"]), targetMin: 45 },
  { label: "Instagram", apps: new Set(["Instagram"]), targetMin: 10 },
  { label: "Dating", apps: new Set(["Raya", "Tinder", "Hinge", "Bumble"]), targetMin: 0 },
];
/** Min days/week required to pass the protein rule. */
export const PROTEIN_DAYS_TARGET = 5;
export const PROTEIN_DEFAULT_TARGET_G = 221;

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

/* ---------- detail-only inputs (not part of meter average) ---------- */

function cleanScreentime(rows: ScreenTimeRow[]): ScreenTimeRow[] {
  return dedupeAppsPreferMac(dropCategoryRows(dropMacNonBundleIdLabels(rows)));
}

async function writingInput(): Promise<{ score: number; label: string }> {
  const targetRaw = await getSetting("writing_target_hr_per_week");
  const targetHr =
    Number.isFinite(Number(targetRaw)) && Number(targetRaw) > 0
      ? Number(targetRaw)
      : WRITING_TARGET_HR_DEFAULT;
  const targetMin = targetHr * 60;
  const rows = cleanScreentime(await getRecentScreentime(WINDOW_DAYS));
  const writingMin = rows
    .filter((r) => r.label === WRITING_BUNDLE_ID)
    .reduce((s, r) => s + r.minutes, 0);
  return {
    score: targetMin === 0 ? 1 : Math.min(writingMin / targetMin, 1),
    label: `Writing ${targetHr} hr/week`,
  };
}

async function screentimeInput(): Promise<number> {
  const rows = cleanScreentime(await getRecentScreentime(WINDOW_DAYS));
  const dates = [...new Set(rows.map((r) => r.date))];
  if (dates.length === 0) return 0;
  let passed = 0;
  for (const date of dates) {
    const dayRows = rows.filter((r) => r.date === date);
    let breach = false;
    for (const b of SCREENTIME_BUCKETS) {
      const min = dayRows
        .filter((r) => b.apps.has(displayAppName(r.label)))
        .reduce((s, r) => s + r.minutes, 0);
      if (min > b.targetMin) {
        breach = true;
        break;
      }
    }
    if (!breach) passed++;
  }
  return passed / dates.length;
}

async function proteinInput(): Promise<number> {
  const rows = await getRecentAppleHealth(WINDOW_DAYS);
  const withProtein = rows.filter((r) => typeof r.proteinG === "number" && r.proteinG > 0);
  if (withProtein.length === 0) return 0;
  const raw = await getSetting("nutrition_protein_target_g");
  const target =
    Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : PROTEIN_DEFAULT_TARGET_G;
  const daysHit = withProtein.filter((r) => (r.proteinG ?? 0) >= target).length;
  return Math.min(daysHit / PROTEIN_DAYS_TARGET, 1);
}

/**
 * Worship score = days in last 7 where minutes ≥ daily target. Returns null
 * when the daily target slider is 0 — that's how Harley keeps the rule
 * dormant and out of the status card.
 */
async function worshipInput(): Promise<{ score: number; label: string } | null> {
  const raw = await getSetting("worship_daily_target_min");
  const targetMin = Number(raw);
  if (!Number.isFinite(targetMin) || targetMin <= 0) return null;
  const rows = await getRecentWorshipLog(WINDOW_DAYS);
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + (r.minutes || 0));
  const days = [...perDay.values()].filter((m) => m >= targetMin).length;
  return {
    score: days / WINDOW_DAYS,
    label: `Worship ${formatHm(targetMin)}/day`,
  };
}

async function edgesInput(): Promise<{ score: number; label: string } | null> {
  const raw = await getSetting("edges_daily_target");
  const target = Number(raw);
  if (!Number.isFinite(target) || target <= 0) return null;
  const rows = await getRecentEdgeLog(WINDOW_DAYS);
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);
  const days = [...perDay.values()].filter((c) => c >= target).length;
  return {
    score: days / WINDOW_DAYS,
    label: `Edges ${target}/day`,
  };
}

function formatHm(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
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
  id:
    | "wake"
    | "bed"
    | "gym"
    | "steps"
    | "water"
    | "writing"
    | "screentime"
    | "protein"
    | "worship"
    | "edges";
  label: string;
  /** 0..1 input score (only the original 5 contribute to the meter average). */
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
 * Per-rule breakdown for the Goddess panel "Dan's last 7 days" card. Includes
 * both the five meter inputs (which feed the score) and the five fineable
 * extras (writing/screentime/protein/worship/edges). The extras don't feed the
 * meter average — they're shown for visibility only.
 *
 * `worship` and `edges` are filtered out when their daily-target slider is 0
 * (rule dormant) so the dormant rules don't clutter the card.
 */
export const getHarleyMeterDetail = unstable_cache(
  async (): Promise<HarleyRuleStatus[]> => {
    if (!isConfigured()) return [];
    const [wake, bed, gym, steps, water, writing, screentime, protein, worship, edges] =
      await Promise.all([
        wakeInput(),
        bedInput(),
        gymInput(),
        stepsInput(),
        waterInput(),
        writingInput(),
        screentimeInput(),
        proteinInput(),
        worshipInput(),
        edgesInput(),
      ]);
    const rows: HarleyRuleStatus[] = [
      { id: "wake", label: "Wake by 06:30", score: wake, state: bucket(wake) },
      { id: "bed", label: "Bed by 22:30", score: bed, state: bucket(bed) },
      { id: "gym", label: "Gym 4+/week", score: gym, state: bucket(gym) },
      { id: "steps", label: "70k steps/week", score: steps, state: bucket(steps) },
      { id: "water", label: "3.3 L water/day", score: water, state: bucket(water) },
      {
        id: "writing",
        label: writing.label,
        score: writing.score,
        state: bucket(writing.score),
      },
      {
        id: "screentime",
        label: "Screen Time within targets",
        score: screentime,
        state: bucket(screentime),
      },
      { id: "protein", label: "Protein 5+ days/week", score: protein, state: bucket(protein) },
    ];
    if (worship) {
      rows.push({
        id: "worship",
        label: worship.label,
        score: worship.score,
        state: bucket(worship.score),
      });
    }
    if (edges) {
      rows.push({
        id: "edges",
        label: edges.label,
        score: edges.score,
        state: bucket(edges.score),
      });
    }
    return rows;
  },
  ["dashboard:harley-meter-detail"],
  { revalidate: 30 }
);
