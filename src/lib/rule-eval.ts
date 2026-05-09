/**
 * Auto rule-eval — reads Harley Meter inputs and writes Punishments
 * rows for failed rules. Idempotent on (ruleId, periodStart): once a
 * rule has been fined for a given period (a date for daily rules, the
 * Monday of the week for weekly rules), it is never fined again, even
 * across re-runs or catch-up after downtime.
 *
 * Daily rules (one fine per failed day):
 *   wake — Whoop wake time > 06:30 Sydney
 *   bed  — Whoop sleep onset > 22:30 Sydney (00:00–05:59 = next day)
 *
 * Weekly rules (one fine per failed Mon-Sun, evaluated on Mondays):
 *   gym   — < 4 Whoop workouts
 *   steps — < 70k Apple Health steps
 *   water — < 3.3 L Apple Health waterMl daily average
 *   tasks — < 4 Harley-authored past calendar events
 *
 * Daily rules look back 7 days so a missed cron run can catch up. Weekly
 * rules only fire on Monday — skipping a Monday means that week is
 * forfeited (Harley can append manually). Triggered by
 * /api/cron/rule-eval/route.ts at 02:00 Sydney via GitHub Actions.
 */
import {
  appendPunishment,
  getAllPunishments,
  getRecentAppleHealth,
  getRecentWhoopDaily,
  countWhoopWorkoutsInRange,
  isConfigured,
  todaySydneyISO,
  type WhoopDaily,
  type AppleHealthRow,
  type Punishment,
} from "./sheets";
import { getHarleyTaskWindow, isCalendarConfigured } from "./calendar";
import {
  WAKE_BY_MIN,
  BED_BY_MIN,
  GYM_TARGET_PER_WEEK,
  STEPS_TARGET_PER_WEEK,
  WATER_TARGET_ML_PER_DAY,
  HARLEY_TASK_TARGET_PER_WEEK,
} from "./harley-meter";
import type { HarleyRuleId } from "./harley-rules";

export type FineAmounts = Record<HarleyRuleId, number>;

export const FINE_AMOUNTS: FineAmounts = {
  wake: 10,
  bed: 10,
  gym: 25,
  steps: 20,
  water: 20,
  tasks: 25,
};

export type RuleEvalCandidate = {
  ruleId: HarleyRuleId;
  periodStart: string;
  amount: number;
  reason: string;
  setBy: string;
};

export type RuleEvalResult = {
  appended: RuleEvalCandidate[];
  skipped: Array<RuleEvalCandidate & { skipReason: "already_fined" | "no_data" }>;
  errors: Array<{ ruleId: string; periodStart: string; error: string }>;
};

/* ---------- date helpers (Sydney TZ) ---------- */

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(iso + "T12:00:00Z") + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sydney day-of-week for a YYYY-MM-DD (0=Sun..6=Sat). */
function sydneyDayOfWeek(iso: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    weekday: "short",
  });
  const short = fmt.format(new Date(iso + "T12:00:00Z"));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}

/** Monday of the ISO week containing the given Sydney date. */
function mondayOf(iso: string): string {
  const dow = sydneyDayOfWeek(iso); // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  return addDaysISO(iso, -back);
}

/* ---------- threshold parsing (mirrored from harley-meter.ts) ---------- */

function clockToMin(raw: string): number | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function bedTimeToMin(raw: string): number | null {
  const min = clockToMin(raw);
  if (min === null) return null;
  if (min < 6 * 60) return min + 24 * 60;
  return min;
}

function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ---------- rule scorers ---------- */

function scoreWakeForDay(row: WhoopDaily | undefined): { failed: boolean; detail?: string } {
  if (!row) return { failed: false };
  const min = clockToMin(row.wakeTime);
  if (min === null) return { failed: false };
  if (min <= WAKE_BY_MIN) return { failed: false };
  return { failed: true, detail: fmtClock(min) };
}

function scoreBedForDay(row: WhoopDaily | undefined): { failed: boolean; detail?: string } {
  if (!row) return { failed: false };
  const min = bedTimeToMin(row.bedTime);
  if (min === null) return { failed: false };
  if (min <= BED_BY_MIN) return { failed: false };
  return { failed: true, detail: fmtClock(min) };
}

/* ---------- candidate builders ---------- */

const DAILY_LOOKBACK = 7;

function dailyDates(today: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= DAILY_LOOKBACK; i++) out.push(addDaysISO(today, -i));
  return out;
}

async function buildWakeCandidates(today: string): Promise<RuleEvalCandidate[]> {
  const rows = await getRecentWhoopDaily(DAILY_LOOKBACK + 1);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const candidates: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const score = scoreWakeForDay(byDate.get(date));
    if (!score.failed) continue;
    candidates.push({
      ruleId: "wake",
      periodStart: date,
      amount: FINE_AMOUNTS.wake,
      reason: `Late wake (${score.detail}) — ${date}`,
      setBy: "auto",
    });
  }
  return candidates;
}

async function buildBedCandidates(today: string): Promise<RuleEvalCandidate[]> {
  const rows = await getRecentWhoopDaily(DAILY_LOOKBACK + 1);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const candidates: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const score = scoreBedForDay(byDate.get(date));
    if (!score.failed) continue;
    candidates.push({
      ruleId: "bed",
      periodStart: date,
      amount: FINE_AMOUNTS.bed,
      reason: `Late bed (${score.detail}) — ${date}`,
      setBy: "auto",
    });
  }
  return candidates;
}

async function buildGymCandidate(weekStart: string, weekEnd: string): Promise<RuleEvalCandidate | null> {
  const count = await countWhoopWorkoutsInRange(weekStart, weekEnd);
  if (count >= GYM_TARGET_PER_WEEK) return null;
  return {
    ruleId: "gym",
    periodStart: weekStart,
    amount: FINE_AMOUNTS.gym,
    reason: `Missed gym target (${count}/${GYM_TARGET_PER_WEEK}) — week of ${weekStart}`,
    setBy: "auto",
  };
}

function filterRowsInRange(rows: AppleHealthRow[], start: string, end: string): AppleHealthRow[] {
  return rows.filter((r) => r.date >= start && r.date <= end);
}

// "Enough data to fine" threshold for Apple Health rules. A week with fewer
// than this many days of logged steps/water means ingestion likely lapsed —
// fining for 26 steps over a week (real outcome of an unscored 2026-05-04
// dry run) is wrong. Treat as "can't evaluate, skip" instead.
const APPLE_HEALTH_MIN_DAYS = 5;

async function buildStepsCandidate(weekStart: string, weekEnd: string): Promise<RuleEvalCandidate | null> {
  const rows = filterRowsInRange(await getRecentAppleHealth(14), weekStart, weekEnd);
  const daysWithSteps = rows.filter((r) => (r.steps || 0) > 0).length;
  if (daysWithSteps < APPLE_HEALTH_MIN_DAYS) return null;
  const total = rows.reduce((s, r) => s + (r.steps || 0), 0);
  if (total >= STEPS_TARGET_PER_WEEK) return null;
  return {
    ruleId: "steps",
    periodStart: weekStart,
    amount: FINE_AMOUNTS.steps,
    reason: `Missed steps target (${total.toLocaleString("en-AU")}/${STEPS_TARGET_PER_WEEK.toLocaleString("en-AU")}) — week of ${weekStart}`,
    setBy: "auto",
  };
}

async function buildWaterCandidate(weekStart: string, weekEnd: string): Promise<RuleEvalCandidate | null> {
  const rows = filterRowsInRange(await getRecentAppleHealth(14), weekStart, weekEnd);
  const withWater = rows.filter((r) => typeof r.waterMl === "number" && r.waterMl > 0);
  if (withWater.length < APPLE_HEALTH_MIN_DAYS) return null;
  const totalMl = withWater.reduce((s, r) => s + (r.waterMl || 0), 0);
  const avgMl = totalMl / withWater.length;
  if (avgMl >= WATER_TARGET_ML_PER_DAY) return null;
  return {
    ruleId: "water",
    periodStart: weekStart,
    amount: FINE_AMOUNTS.water,
    reason: `Missed water target (${(avgMl / 1000).toFixed(1)}L avg / ${(WATER_TARGET_ML_PER_DAY / 1000).toFixed(1)}L) — week of ${weekStart}`,
    setBy: "auto",
  };
}

async function buildTasksCandidate(weekStart: string, weekEnd: string): Promise<RuleEvalCandidate | null> {
  if (!isCalendarConfigured()) return null;
  const { past } = await getHarleyTaskWindow();
  const startMs = Date.parse(weekStart + "T00:00:00+10:00");
  const endMs = Date.parse(weekEnd + "T23:59:59+10:00");
  const inRange = past.filter((t) => {
    const ms = Date.parse(t.startISO);
    return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
  });
  if (inRange.length >= HARLEY_TASK_TARGET_PER_WEEK) return null;
  return {
    ruleId: "tasks",
    periodStart: weekStart,
    amount: FINE_AMOUNTS.tasks,
    reason: `Missed tasks target (${inRange.length}/${HARLEY_TASK_TARGET_PER_WEEK}) — week of ${weekStart}`,
    setBy: "auto",
  };
}

/* ---------- top-level orchestration ---------- */

export async function evaluateRulesAndFine(
  opts: { dryRun?: boolean; today?: string } = {}
): Promise<RuleEvalResult> {
  const result: RuleEvalResult = { appended: [], skipped: [], errors: [] };
  if (!isConfigured()) return result;

  const today = opts.today || todaySydneyISO();

  const candidates: RuleEvalCandidate[] = [];

  // Daily rules — last 7 days each.
  candidates.push(...(await buildWakeCandidates(today)));
  candidates.push(...(await buildBedCandidates(today)));

  // Weekly rules — only fire on Monday for the previous Mon–Sun. The
  // skipped-Monday case is intentional: catching up week-by-week opens
  // boundary bugs we don't need (Harley can fine manually if needed).
  const isMonday = sydneyDayOfWeek(today) === 1;
  if (isMonday) {
    const prevMon = addDaysISO(mondayOf(today), -7);
    const prevSun = addDaysISO(prevMon, 6);
    const weekly = await Promise.all([
      buildGymCandidate(prevMon, prevSun),
      buildStepsCandidate(prevMon, prevSun),
      buildWaterCandidate(prevMon, prevSun),
      buildTasksCandidate(prevMon, prevSun),
    ]);
    for (const c of weekly) if (c) candidates.push(c);
  }

  // Idempotency: dedupe against existing Punishments by (ruleId, date).
  const existing = await loadExistingKeys();

  for (const c of candidates) {
    const key = `${c.ruleId}|${c.periodStart}`;
    if (existing.has(key)) {
      result.skipped.push({ ...c, skipReason: "already_fined" });
      continue;
    }
    if (opts.dryRun) {
      result.appended.push(c);
      continue;
    }
    try {
      await appendPunishment({
        amount: c.amount,
        reason: c.reason,
        setBy: c.setBy,
        ruleId: c.ruleId,
        date: c.periodStart,
      });
      existing.add(key); // protect against same-batch dupes
      result.appended.push(c);
    } catch (e) {
      result.errors.push({
        ruleId: c.ruleId,
        periodStart: c.periodStart,
        error: (e as Error).message,
      });
    }
  }

  return result;
}

async function loadExistingKeys(): Promise<Set<string>> {
  const all: Punishment[] = await getAllPunishments();
  const keys = new Set<string>();
  for (const p of all) {
    if (!p.ruleId) continue;
    keys.add(`${p.ruleId}|${p.date}`);
  }
  return keys;
}
