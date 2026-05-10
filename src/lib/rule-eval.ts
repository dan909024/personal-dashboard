/**
 * Auto rule-eval — reads Harley Meter inputs and writes Punishments
 * rows for failed rules. Idempotent on (ruleId, periodStart): once a
 * rule has been fined for a given period (a date for daily rules, the
 * Monday of the week for weekly rules), it is never fined again, even
 * across re-runs or catch-up after downtime.
 *
 * Daily rules (one fine per failed day):
 *   wake       — Whoop wake time > 06:30 Sydney
 *   bed        — Whoop sleep onset > 22:30 Sydney (00:00–05:59 = next day)
 *   screentime — any Screen Time bucket exceeded its target
 *   worship    — Worship Log minutes for the day < worship_daily_target_min
 *   edges      — Edge Log count for the day < edges_daily_target
 *
 * `worship` and `edges` are dormant until both their fine amount and target
 * setting are > 0; that's how Harley keeps them inactive on the panel slider
 * without code changes.
 *
 * Weekly rules (one fine per failed Mon-Sun, evaluated on Sundays):
 *   gym     — < 4 Whoop workouts
 *   steps   — < 70k Apple Health steps
 *   water   — < 3.3 L Apple Health waterMl daily average
 *   writing — < writing_target_hr_per_week (default 8) of Obsidian foreground time
 *   protein — < 5 days of ≥ nutrition_protein_target_g dietary protein
 *
 * Daily rules look back 7 days so a missed cron run can catch up. Weekly
 * rules only fire on Sunday — skipping a Sunday means that week is
 * forfeited (Harley can append manually). Triggered by
 * /api/cron/rule-eval/route.ts at 22:00 Sydney via GitHub Actions.
 */
import {
  appendPunishment,
  getAllPunishments,
  getRecentAppleHealth,
  getRecentEdgeLog,
  getRecentScreentime,
  getRecentWhoopDaily,
  getRecentWorshipLog,
  countWhoopWorkoutsInRange,
  getSetting,
  isConfigured,
  todaySydneyISO,
  type WhoopDaily,
  type AppleHealthRow,
  type Punishment,
  type ScreenTimeRow,
} from "./sheets";
import {
  WAKE_BY_MIN,
  BED_BY_MIN,
  GYM_TARGET_PER_WEEK,
  STEPS_TARGET_PER_WEEK,
  WATER_TARGET_ML_PER_DAY,
} from "./harley-meter";
import {
  displayAppName,
  dedupeAppsPreferMac,
  dropCategoryRows,
  dropMacNonBundleIdLabels,
} from "./screentime-display";
import {
  DEFAULT_FINE_AMOUNTS,
  fineAmountSettingKey,
  HARLEY_RULES,
  type HarleyRuleId,
} from "./harley-rules";

/* ---------- new-rule thresholds ---------- */

/** Obsidian bundle id used for writing-rule scoring. */
const WRITING_BUNDLE_ID = "md.obsidian";
/** Default weekly writing-hours target (overridable via Settings `writing_target_hr_per_week`). */
const WRITING_TARGET_HR_DEFAULT = 8;
/** Min days of any Screen Time data in a week before we'll fine — guards against ingestion lapses. */
const SCREENTIME_MIN_DAYS = 5;

/**
 * Daily Screen Time buckets fined when over target. Mirrors the
 * dashboard SCREENTIME tile's buckets but is a separate copy so the
 * fineable thresholds can drift from the display tile if needed.
 */
const SCREENTIME_BUCKETS: Array<{ label: string; apps: Set<string>; targetMin: number }> = [
  { label: "YouTube", apps: new Set(["YouTube"]), targetMin: 45 },
  { label: "Instagram", apps: new Set(["Instagram"]), targetMin: 10 },
  { label: "Dating", apps: new Set(["Raya", "Tinder", "Hinge", "Bumble"]), targetMin: 0 },
];

/** Min days/week required to pass the protein rule. */
const PROTEIN_DAYS_TARGET = 5;
const PROTEIN_DEFAULT_TARGET_G = 221;

/** Settings keys for the daily-target sliders Harley sets from the panel. */
export const WORSHIP_DAILY_TARGET_MIN_KEY = "worship_daily_target_min";
export const EDGES_DAILY_TARGET_KEY = "edges_daily_target";

export type FineAmounts = Record<HarleyRuleId, number>;

/** Back-compat alias — defaults table that ships with the app. */
export const FINE_AMOUNTS: FineAmounts = DEFAULT_FINE_AMOUNTS;

/**
 * Read the live per-rule fine amounts. Each rule's `fine_amount_<id>` row in
 * Settings overrides its default; missing or unparseable rows fall back to
 * `DEFAULT_FINE_AMOUNTS`. Used by the auto rule-eval cron, the slip button,
 * and the Harley panel's "Fine schedule" section.
 */
export async function getFineAmounts(): Promise<FineAmounts> {
  const ids = Object.keys(HARLEY_RULES) as HarleyRuleId[];
  const out: FineAmounts = { ...DEFAULT_FINE_AMOUNTS };
  const raws = await Promise.all(
    ids.map((id) => getSetting(fineAmountSettingKey(id)))
  );
  ids.forEach((id, i) => {
    const n = Number(raws[i]);
    if (Number.isFinite(n) && n > 0) out[id] = n;
  });
  return out;
}

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

async function buildWakeCandidates(today: string, amount: number): Promise<RuleEvalCandidate[]> {
  const rows = await getRecentWhoopDaily(DAILY_LOOKBACK + 1);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const candidates: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const score = scoreWakeForDay(byDate.get(date));
    if (!score.failed) continue;
    candidates.push({
      ruleId: "wake",
      periodStart: date,
      amount,
      reason: `Late wake (${score.detail}) — ${date}`,
      setBy: "auto",
    });
  }
  return candidates;
}

async function buildBedCandidates(today: string, amount: number): Promise<RuleEvalCandidate[]> {
  const rows = await getRecentWhoopDaily(DAILY_LOOKBACK + 1);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const candidates: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const score = scoreBedForDay(byDate.get(date));
    if (!score.failed) continue;
    candidates.push({
      ruleId: "bed",
      periodStart: date,
      amount,
      reason: `Late bed (${score.detail}) — ${date}`,
      setBy: "auto",
    });
  }
  return candidates;
}

async function buildGymCandidate(weekStart: string, weekEnd: string, amount: number): Promise<RuleEvalCandidate | null> {
  const count = await countWhoopWorkoutsInRange(weekStart, weekEnd);
  if (count >= GYM_TARGET_PER_WEEK) return null;
  return {
    ruleId: "gym",
    periodStart: weekStart,
    amount,
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

async function buildStepsCandidate(weekStart: string, weekEnd: string, amount: number): Promise<RuleEvalCandidate | null> {
  const rows = filterRowsInRange(await getRecentAppleHealth(14), weekStart, weekEnd);
  const daysWithSteps = rows.filter((r) => (r.steps || 0) > 0).length;
  if (daysWithSteps < APPLE_HEALTH_MIN_DAYS) return null;
  const total = rows.reduce((s, r) => s + (r.steps || 0), 0);
  if (total >= STEPS_TARGET_PER_WEEK) return null;
  return {
    ruleId: "steps",
    periodStart: weekStart,
    amount,
    reason: `Missed steps target (${total.toLocaleString("en-AU")}/${STEPS_TARGET_PER_WEEK.toLocaleString("en-AU")}) — week of ${weekStart}`,
    setBy: "auto",
  };
}

async function buildWaterCandidate(weekStart: string, weekEnd: string, amount: number): Promise<RuleEvalCandidate | null> {
  const rows = filterRowsInRange(await getRecentAppleHealth(14), weekStart, weekEnd);
  const withWater = rows.filter((r) => typeof r.waterMl === "number" && r.waterMl > 0);
  if (withWater.length < APPLE_HEALTH_MIN_DAYS) return null;
  const totalMl = withWater.reduce((s, r) => s + (r.waterMl || 0), 0);
  const avgMl = totalMl / withWater.length;
  if (avgMl >= WATER_TARGET_ML_PER_DAY) return null;
  return {
    ruleId: "water",
    periodStart: weekStart,
    amount,
    reason: `Missed water target (${(avgMl / 1000).toFixed(1)}L avg / ${(WATER_TARGET_ML_PER_DAY / 1000).toFixed(1)}L) — week of ${weekStart}`,
    setBy: "auto",
  };
}

/* ---------- new rule scorers (writing / screentime / protein / worship / edges) ---------- */

function cleanScreentime(rows: ScreenTimeRow[]): ScreenTimeRow[] {
  return dedupeAppsPreferMac(dropCategoryRows(dropMacNonBundleIdLabels(rows)));
}

async function buildWritingCandidate(
  weekStart: string,
  weekEnd: string,
  amount: number
): Promise<RuleEvalCandidate | null> {
  // Pull the live weekly target from Settings (falls back to 8 hours).
  const targetRaw = await getSetting("writing_target_hr_per_week");
  const targetHr =
    Number.isFinite(Number(targetRaw)) && Number(targetRaw) > 0
      ? Number(targetRaw)
      : WRITING_TARGET_HR_DEFAULT;
  const targetMin = targetHr * 60;

  // Need a baseline of Screen Time coverage for the week before fining
  // for "no writing" — an ingestion lapse looks identical to a no-write week.
  const allWeek = cleanScreentime(await getRecentScreentime(14)).filter(
    (r) => r.date >= weekStart && r.date <= weekEnd
  );
  const daysWithData = new Set(allWeek.map((r) => r.date)).size;
  if (daysWithData < SCREENTIME_MIN_DAYS) return null;

  const writingMin = allWeek
    .filter((r) => r.label === WRITING_BUNDLE_ID)
    .reduce((s, r) => s + r.minutes, 0);
  if (writingMin >= targetMin) return null;
  return {
    ruleId: "writing",
    periodStart: weekStart,
    amount,
    reason: `Writing target missed (${(writingMin / 60).toFixed(1)}/${targetHr} hr) — week of ${weekStart}`,
    setBy: "auto",
  };
}

async function buildScreentimeCandidates(today: string, amount: number): Promise<RuleEvalCandidate[]> {
  const rows = cleanScreentime(await getRecentScreentime(DAILY_LOOKBACK + 1));
  const out: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const dayRows = rows.filter((r) => r.date === date);
    // Skip days with no Screen Time data — ingestion lapses shouldn't generate fines.
    if (dayRows.length === 0) continue;
    const breaches: string[] = [];
    for (const b of SCREENTIME_BUCKETS) {
      const minutes = dayRows
        .filter((r) => b.apps.has(displayAppName(r.label)))
        .reduce((s, r) => s + r.minutes, 0);
      if (minutes > b.targetMin) {
        breaches.push(`${b.label} ${minutes}m/${b.targetMin}m`);
      }
    }
    if (breaches.length === 0) continue;
    out.push({
      ruleId: "screentime",
      periodStart: date,
      amount,
      reason: `Screen Time bucket(s) over: ${breaches.join(", ")} — ${date}`,
      setBy: "auto",
    });
  }
  return out;
}

async function buildProteinCandidate(
  weekStart: string,
  weekEnd: string,
  amount: number
): Promise<RuleEvalCandidate | null> {
  const rows = filterRowsInRange(await getRecentAppleHealth(14), weekStart, weekEnd);
  const withProtein = rows.filter((r) => typeof r.proteinG === "number" && r.proteinG > 0);
  if (withProtein.length < APPLE_HEALTH_MIN_DAYS) return null;
  // Pull the live protein target from Settings (falls back to the dashboard
  // default of 221g if the row is missing or unparseable).
  const raw = await getSetting("nutrition_protein_target_g");
  const target =
    Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : PROTEIN_DEFAULT_TARGET_G;
  const daysHit = withProtein.filter((r) => (r.proteinG ?? 0) >= target).length;
  if (daysHit >= PROTEIN_DAYS_TARGET) return null;
  return {
    ruleId: "protein",
    periodStart: weekStart,
    amount,
    reason: `Protein target missed (${daysHit}/${PROTEIN_DAYS_TARGET} days ≥${target}g) — week of ${weekStart}`,
    setBy: "auto",
  };
}

/**
 * Daily worship rule. Reads the daily-minutes target from the
 * `worship_daily_target_min` Setting (set via the Daily targets slider on
 * the Harley panel). Returns no candidates while the target is 0 — that's
 * how Harley keeps the rule dormant until she's ready to enforce it.
 */
async function buildWorshipCandidates(today: string, amount: number): Promise<RuleEvalCandidate[]> {
  const raw = await getSetting(WORSHIP_DAILY_TARGET_MIN_KEY);
  const targetMin = Number(raw);
  if (!Number.isFinite(targetMin) || targetMin <= 0) return [];
  const rows = await getRecentWorshipLog(DAILY_LOOKBACK + 1);
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + (r.minutes || 0));
  const out: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const got = perDay.get(date) ?? 0;
    if (got >= targetMin) continue;
    out.push({
      ruleId: "worship",
      periodStart: date,
      amount,
      reason: `Worship target missed (${got}/${targetMin} min) — ${date}`,
      setBy: "auto",
    });
  }
  return out;
}

/**
 * Daily edges rule. Reads the daily-count target from `edges_daily_target`.
 * Same dormant-until-set behavior as worship: no candidates while target is 0.
 */
async function buildEdgesCandidates(today: string, amount: number): Promise<RuleEvalCandidate[]> {
  const raw = await getSetting(EDGES_DAILY_TARGET_KEY);
  const target = Number(raw);
  if (!Number.isFinite(target) || target <= 0) return [];
  const rows = await getRecentEdgeLog(DAILY_LOOKBACK + 1);
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);
  const out: RuleEvalCandidate[] = [];
  for (const date of dailyDates(today)) {
    const got = perDay.get(date) ?? 0;
    if (got >= target) continue;
    out.push({
      ruleId: "edges",
      periodStart: date,
      amount,
      reason: `Edges target missed (${got}/${target}) — ${date}`,
      setBy: "auto",
    });
  }
  return out;
}

/* ---------- top-level orchestration ---------- */

export async function evaluateRulesAndFine(
  opts: { dryRun?: boolean; today?: string } = {}
): Promise<RuleEvalResult> {
  const result: RuleEvalResult = { appended: [], skipped: [], errors: [] };
  if (!isConfigured()) return result;

  const today = opts.today || todaySydneyISO();
  const amounts = await getFineAmounts();

  const candidates: RuleEvalCandidate[] = [];

  // Daily rules — last 7 days each. Each scorer takes its own fine amount;
  // worship/edges short-circuit when amount or target is 0 (rule disabled).
  candidates.push(...(await buildWakeCandidates(today, amounts.wake)));
  candidates.push(...(await buildBedCandidates(today, amounts.bed)));
  candidates.push(...(await buildScreentimeCandidates(today, amounts.screentime)));
  if (amounts.worship > 0) {
    candidates.push(...(await buildWorshipCandidates(today, amounts.worship)));
  }
  if (amounts.edges > 0) {
    candidates.push(...(await buildEdgesCandidates(today, amounts.edges)));
  }

  // Weekly rules — only fire on Sunday and score the just-ending Mon–Sun.
  // Cron tick is 22:00 Sydney so Daniel sees the verdict before bed
  // instead of waking up Monday to fines. Activity logged 22:00–23:59 Sun
  // doesn't count toward this eval (rolls into next week). The skipped-
  // Sunday case is intentional: catching up week-by-week opens boundary
  // bugs we don't need (manual fines can fill any gap via /fine).
  const isSunday = sydneyDayOfWeek(today) === 0;
  if (isSunday) {
    const weekStart = addDaysISO(today, -6); // Monday of this just-ending week
    const weekEnd = today;                    // Sunday = today
    const weekly = await Promise.all([
      buildGymCandidate(weekStart, weekEnd, amounts.gym),
      buildStepsCandidate(weekStart, weekEnd, amounts.steps),
      buildWaterCandidate(weekStart, weekEnd, amounts.water),
      buildWritingCandidate(weekStart, weekEnd, amounts.writing),
      buildProteinCandidate(weekStart, weekEnd, amounts.protein),
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
