/**
 * Weekly rules evaluator. Pure function: takes the week's data sources
 * + active rules and returns one outcome per rule for the Mon-Sun
 * window. The cron at /api/cron/rules-evaluate-week orchestrates the
 * Sheet reads/writes; the dashboard estimate component imports this
 * to render the running current-week total.
 *
 * Per-rule semantics (one switch arm each):
 *   wake_late        — Whoop wake time per day; sum minutes-late across
 *                      all 7 days; fine = ceil(totalMinutesLate / 15) × $.
 *   bed_late         — Count nights past 22:30 (or before 06:00 next
 *                      morning); fine = count × $.
 *   steps_short      — Sum Apple Health steps Mon-Sun; if below threshold,
 *                      fine = ceil(shortfall / 10000) × $.
 *   gym_skipped      — Whoop workout count Mon-Sun < threshold → flat $.
 *   strain_low       — Per workout day, max strain < threshold → fail;
 *                      fine = (count of low-strain workout days) × $.
 *   ig_over          — Per day Instagram minutes > threshold; over-blocks
 *                      = ceil(over / 5) summed across 7 days; fine = blocks × $.
 *   yt_over          — Same as ig_over for YouTube.
 *   dating_app_used  — Count days with any dating-app minutes; fine = count × $.
 *   whoop_no_data    — Count days with no Whoop daily row; fine = count × $.
 */
import type { RuleCheckRow } from "./sheets";

export type WhoopDailyLite = { date: string; recovery: string; wakeTime: string; bedTime: string };
export type WhoopWorkoutLite = { date: string; sportId: number | null; strain: number | null };
export type ScreentimeLite = { date: string; source: string; label: string; minutes: number; syncedAt: string };

export type WeekInput = {
  /** ISO week id, e.g. "2026-W18". Used in Reason text for idempotency. */
  weekId: string;
  /** Days included in the evaluation. Full week = 7 days; partial week = subset. */
  days: string[];
  /** Whoop daily rows keyed by ISO date. */
  whoopByDate: Map<string, WhoopDailyLite>;
  /** All workouts in the week. */
  workouts: WhoopWorkoutLite[];
  /** Apple Health steps per day. Missing date = 0 steps. */
  stepsByDate: Map<string, number>;
  /** Cleaned screen time rows per day (categories dropped, sources deduped, mac-preferred). */
  screentimeByDate: Map<string, ScreentimeLite[]>;
};

export type WeeklyOutcome = {
  ruleId: string;
  /** "passed" = clean week. "failed" = fine fires. "skipped" = data unreliable, no fine. */
  state: "passed" | "failed" | "skipped";
  fineAmount: number;
  /** Human-readable summary, e.g. "4 late wakes · 92m total = 7×$10". */
  summary: string;
  /** Punishments-row Reason text. Encodes ruleId + week → cron is idempotent. */
  reasonText: string;
};

const IG = new Set(["com.burbn.instagram", "Instagram"]);
const YT = new Set(["com.google.ios.youtube", "YouTube"]);
const DATING = new Set([
  "com.cardify.tinder", "co.match.tinder", "com.hinge.app", "com.bumble.app",
  "Tinder", "Hinge", "Bumble",
]);
// Match dashboard PHONE tile: minutes >= 18h are treated as bogus
// (likely mac_launchd "app open all day" or 24h ingest cap) and excluded
// from rule-fine math so we never fine on garbage data.
const SCREENTIME_SUSPICIOUS_MIN = 18 * 60;

export function evaluateWeek(rules: RuleCheckRow[], input: WeekInput): WeeklyOutcome[] {
  const out: WeeklyOutcome[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    const result = evalOne(rule, input);
    if (result) out.push(result);
  }
  return out;
}

function evalOne(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome | null {
  switch (rule.id) {
    case "wake_late": return evalWakeLate(rule, input);
    case "bed_late": return evalBedLate(rule, input);
    case "steps_short": return evalStepsShort(rule, input);
    case "gym_skipped": return evalGymSkipped(rule, input);
    case "strain_low": return evalStrainLow(rule, input);
    case "ig_over": return evalScreen(rule, input, IG, "Instagram");
    case "yt_over": return evalScreen(rule, input, YT, "YouTube");
    case "dating_app_used": return evalDating(rule, input);
    case "whoop_no_data": return evalWhoopNoData(rule, input);
    default: return null; // unknown rule — skip rather than blow up the cron
  }
}

function evalWakeLate(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  const t = clockToMin(rule.threshold);
  if (t === null) return passO(rule, input.weekId, "invalid threshold");
  let lateDays = 0; let totalMinLate = 0;
  for (const d of input.days) {
    const w = clockToMin(input.whoopByDate.get(d)?.wakeTime ?? "");
    if (w === null || w <= t) continue;
    lateDays++; totalMinLate += w - t;
  }
  if (lateDays === 0) return passO(rule, input.weekId, "no late wakes");
  const blocks = Math.ceil(totalMinLate / 15);
  return failO(rule, input.weekId,
    `${lateDays} late wake${lateDays === 1 ? "" : "s"} · ${totalMinLate}m total = ${blocks}×$${rule.fine}`,
    rule.fine * blocks);
}

function evalBedLate(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  const t = clockToMin(rule.threshold);
  if (t === null) return passO(rule, input.weekId, "invalid threshold");
  let count = 0;
  for (const d of input.days) {
    const b = bedToMin(input.whoopByDate.get(d)?.bedTime ?? "");
    if (b === null || b <= t) continue;
    count++;
  }
  if (count === 0) return passO(rule, input.weekId, "no late beds");
  return failO(rule, input.weekId,
    `${count} late bed${count === 1 ? "" : "s"} = ${count}×$${rule.fine}`,
    rule.fine * count);
}

function evalStepsShort(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  const target = Number(rule.threshold) || 0;
  const daysWithData = input.days.filter((d) => (input.stepsByDate.get(d) ?? 0) > 0).length;
  const total = input.days.reduce((s, d) => s + (input.stepsByDate.get(d) ?? 0), 0);
  // Data-quality guard: if fewer than half the days have any step data,
  // the Apple Health pipeline is broken — don't fine on a sync gap.
  if (daysWithData < Math.ceil(input.days.length / 2)) {
    return skipO(rule, input.weekId,
      `data unreliable: only ${daysWithData}/${input.days.length} days with steps logged`);
  }
  if (total >= target) {
    return passO(rule, input.weekId, `${total.toLocaleString("en-AU")} steps`);
  }
  const shortfall = target - total;
  const blocks = Math.ceil(shortfall / 10000);
  return failO(rule, input.weekId,
    `${total.toLocaleString("en-AU")}/${target.toLocaleString("en-AU")} steps · ${shortfall.toLocaleString("en-AU")} short = ${blocks}×$${rule.fine}`,
    rule.fine * blocks);
}

function evalGymSkipped(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  const target = Number(rule.threshold) || 0;
  const count = input.workouts.filter((w) => input.days.includes(w.date)).length;
  if (count >= target) return passO(rule, input.weekId, `${count} workouts`);
  return failO(rule, input.weekId, `${count}/${target} workouts logged`, rule.fine);
}

function evalStrainLow(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  const t = Number(rule.threshold) || 0;
  let lowDays = 0;
  for (const d of input.days) {
    const wk = input.workouts.filter((w) => w.date === d);
    if (wk.length === 0) continue;
    const max = wk.reduce((m, w) => (w.strain !== null && w.strain > m ? w.strain : m), 0);
    if (max < t) lowDays++;
  }
  if (lowDays === 0) return passO(rule, input.weekId, "all workout days hit strain");
  return failO(rule, input.weekId,
    `${lowDays} workout day${lowDays === 1 ? "" : "s"} below strain ${t} = ${lowDays}×$${rule.fine}`,
    rule.fine * lowDays);
}

function evalScreen(rule: RuleCheckRow, input: WeekInput, match: Set<string>, name: string): WeeklyOutcome {
  const t = Number(rule.threshold) || 0;
  // Data-quality guard: need at least one day's worth of screen time data
  // anywhere in the week, otherwise the iOS Shortcut is silent and we'd
  // fail to detect overuse — don't pass-or-fail on missing data.
  const daysWithData = input.days.filter((d) => (input.screentimeByDate.get(d) ?? []).length > 0).length;
  if (daysWithData === 0) {
    return skipO(rule, input.weekId, "no screen-time data logged this week");
  }
  let blocks = 0; let overDays = 0; let totalOver = 0;
  for (const d of input.days) {
    const minutes = sumScreentime(input.screentimeByDate.get(d) ?? [], match);
    if (minutes <= t) continue;
    const over = minutes - t;
    blocks += Math.ceil(over / 5);
    overDays++;
    totalOver += over;
  }
  if (blocks === 0) return passO(rule, input.weekId, `${name} within limit all week`);
  return failO(rule, input.weekId,
    `${name} over ${overDays} day${overDays === 1 ? "" : "s"} · ${totalOver}m over = ${blocks}×$${rule.fine}`,
    rule.fine * blocks);
}

function evalDating(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  const daysWithData = input.days.filter((d) => (input.screentimeByDate.get(d) ?? []).length > 0).length;
  if (daysWithData === 0) {
    return skipO(rule, input.weekId, "no screen-time data logged this week");
  }
  let dirty = 0;
  for (const d of input.days) {
    if (sumScreentime(input.screentimeByDate.get(d) ?? [], DATING) > 0) dirty++;
  }
  if (dirty === 0) return passO(rule, input.weekId, "no dating app usage");
  return failO(rule, input.weekId,
    `${dirty} day${dirty === 1 ? "" : "s"} on dating apps = ${dirty}×$${rule.fine}`,
    rule.fine * dirty);
}

function evalWhoopNoData(rule: RuleCheckRow, input: WeekInput): WeeklyOutcome {
  let missing = 0;
  for (const d of input.days) {
    const wd = input.whoopByDate.get(d);
    if (!wd || (!wd.wakeTime && !wd.recovery)) missing++;
  }
  if (missing === 0) return passO(rule, input.weekId, "Whoop synced every day");
  return failO(rule, input.weekId,
    `${missing} missing day${missing === 1 ? "" : "s"} = ${missing}×$${rule.fine}`,
    rule.fine * missing);
}

// ---------- helpers ----------

function clockToMin(raw: string): number | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]); const mn = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mn)) return null;
  return h * 60 + mn;
}

function bedToMin(raw: string): number | null {
  const min = clockToMin(raw);
  if (min === null) return null;
  if (min < 6 * 60) return min + 24 * 60;
  return min;
}

function sumScreentime(rows: ScreentimeLite[], match: Set<string>): number {
  return rows
    .filter((r) => match.has(r.label))
    .filter((r) => r.minutes < SCREENTIME_SUSPICIOUS_MIN)
    .reduce((acc, r) => acc + r.minutes, 0);
}

function passO(rule: RuleCheckRow, weekId: string, summary: string): WeeklyOutcome {
  return {
    ruleId: rule.id,
    state: "passed",
    fineAmount: 0,
    summary,
    reasonText: `[rule:${rule.id}] ${rule.description} (${weekId})`,
  };
}

function failO(rule: RuleCheckRow, weekId: string, summary: string, fineAmount: number): WeeklyOutcome {
  return {
    ruleId: rule.id,
    state: "failed",
    fineAmount,
    summary,
    reasonText: `[rule:${rule.id}] ${summary} (${weekId})`,
  };
}

function skipO(rule: RuleCheckRow, weekId: string, summary: string): WeeklyOutcome {
  return {
    ruleId: rule.id,
    state: "skipped",
    fineAmount: 0,
    summary,
    reasonText: `[rule:${rule.id}] ${rule.description} (${weekId})`,
  };
}

// ---------- Date / week helpers (re-exported for callers) ----------

export function isoWeekContaining(date: string): { monday: string; sunday: string; year: number; week: number } {
  const t = Date.parse(date + "T12:00:00Z");
  const d = new Date(t);
  const day = d.getUTCDay() || 7;
  const monday = new Date(t - (day - 1) * 86400 * 1000).toISOString().slice(0, 10);
  const sunday = new Date(t + (7 - day) * 86400 * 1000).toISOString().slice(0, 10);
  const thursday = new Date(t + (4 - day) * 86400 * 1000);
  const yr = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(yr, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400 * 1000);
  const weeksDiff = Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 86400 * 1000));
  return { monday, sunday, year: yr, week: weeksDiff + 1 };
}

export function weekId(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function daysOfWeek(monday: string): string[] {
  const out: string[] = [];
  const t = Date.parse(monday + "T12:00:00Z");
  for (let i = 0; i < 7; i++) {
    out.push(new Date(t + i * 86400 * 1000).toISOString().slice(0, 10));
  }
  return out;
}

export function sydneyTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
