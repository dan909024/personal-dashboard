/**
 * Phase 5B — Goddess's Weakening Altar
 *
 * Pure compute: phase progression, weakness score, brutal-day bonus,
 * calorie detraction, worship/self-help adjustments, 30-day series.
 * Read sheet rows + settings from src/lib/sheets.ts and pass them in;
 * nothing here touches the network. Tunable from the Settings tab
 * without touching the tile.
 */
import {
  todaySydneyISO,
  getWeaknessRawData,
  getDenialEndDate,
  setSetting,
  type AppleHealthRow,
  type DailyCheckInRow,
  type EdgeLogRow,
  type OrgasmLogRow,
  type SelfHelpLogRow,
  type WeaknessSettings,
  type WorshipLogRow,
} from "./sheets";

// ---------- Phase determination ----------

export type PhaseInfo = {
  name: string;
  flavorText: string;
  currentRangeMin: number;
  currentRangeMax: number;
  nextPhaseName: string | null;
  nextPhaseThreshold: number | null;
  percentToNext: number; // 0-100
};

export function determinePhase(
  score: number,
  settings: WeaknessSettings
): PhaseInfo {
  // Walk phases in declaration order. JSON.parse preserves Object key order
  // for non-numeric keys, so the seed JSON keeps its intended sequence.
  const entries = Object.entries(settings.phase_thresholds) as Array<
    [string, [number, number, string]]
  >;
  if (entries.length === 0) {
    return {
      name: "Unconfigured",
      flavorText: "No phase thresholds set.",
      currentRangeMin: 0,
      currentRangeMax: 0,
      nextPhaseName: null,
      nextPhaseThreshold: null,
      percentToNext: 0,
    };
  }
  let idx = entries.findIndex(([, [min, max]]) => score >= min && score <= max);
  if (idx === -1) {
    // Below first or above last; clamp.
    idx = score < entries[0][1][0] ? 0 : entries.length - 1;
  }
  const [name, [min, max, flavorText]] = entries[idx];
  const next = entries[idx + 1];
  const span = Math.max(1, max - min);
  const through = Math.max(0, Math.min(score, max) - min);
  return {
    name,
    flavorText,
    currentRangeMin: min,
    currentRangeMax: max,
    nextPhaseName: next ? next[0] : null,
    nextPhaseThreshold: next ? next[1][0] : null,
    percentToNext: Math.round((through / span) * 100),
  };
}

// ---------- Edge intensity curve (intensify-then-decay) ----------
//
// `brutal_bonus_threshold` is reinterpreted as the count of edges in the
// INTENSIFY zone — the per-edge multiplier ramps linearly from 1.0 at
// edge #1 to `brutal_bonus_max_multiplier` at edge `threshold`. Past
// the threshold, contributions decay via `weakness_edge_day_decay`
// per excess edge.
//
// Net shape per day-edge index d (0-based):
//   d < threshold − 1:
//     contribution = edge_first × cycle_decay^c × (1 + d × per_step)
//     where per_step = (max − 1) / (threshold − 1)
//   d >= threshold − 1:
//     contribution = edge_first × cycle_decay^c × max × day_decay^(d − (threshold − 1))
//
// First 5–10 edges of the day get more intense (rising); after that
// each additional edge contributes less (decay).

/**
 * Per-edge multiplier for an edge at within-day index `d` (0-indexed).
 * Reports the multiplier ONLY — the cycle_decay and edge_first are
 * applied separately in computeDailyGain.
 */
function edgeIntensityMultiplier(
  d: number,
  settings: WeaknessSettings
): number {
  const peakIndex = Math.max(1, settings.brutal_bonus_threshold) - 1;
  const max = settings.brutal_bonus_max_multiplier;
  if (d <= peakIndex) {
    if (peakIndex === 0) return max;
    return 1.0 + (d / peakIndex) * (max - 1.0);
  }
  const excess = d - peakIndex;
  return max * Math.pow(settings.weakness_edge_day_decay, excess);
}

/**
 * The HEADLINE multiplier reported on the tile = the multiplier applied
 * to the most-recent edge logged today. Mirrors the user-facing meaning
 * of "current intensity" rather than the legacy whole-day multiplier.
 */
export function computeBrutalBonusMultiplier(
  todaysEdges: number,
  settings: WeaknessSettings
): number {
  if (todaysEdges <= 0) return 1.0;
  return edgeIntensityMultiplier(todaysEdges - 1, settings);
}

// ---------- Daily gain ----------

export type DailyGain = {
  gain: number;
  edges: number;
  arousal: number;
  brutalMultiplier: number;
  edgeContribution: number;
  arousalContribution: number;
  worshipContribution: number;
  worshipMinutes: number;
  selfHelpDetraction: number;
  selfHelpMinutes: number;
  calorieDetraction: number;
  activeCalories: number;
  slipCount: number;
  slipPenalty: number;
};

/**
 * Daily gain breakdown. Sum is signed — heavy gym + self-help days can
 * produce negative gain, which the cumulative compute floors at 0.
 */
export function computeDailyGain(
  date: string,
  edgeLogs: EdgeLogRow[],
  cycleEdgesBeforeDay: number,
  checkIns: DailyCheckInRow[],
  worship: WorshipLogRow[],
  selfHelp: SelfHelpLogRow[],
  appleHealth: AppleHealthRow[],
  orgasms: OrgasmLogRow[],
  settings: WeaknessSettings
): DailyGain {
  const todaysEdges = edgeLogs.filter((e) => e.date === date).length;

  // --- Edge curve: per-edge contribution = edge_first × cycle_decay^c × intensity(d)
  // intensity(d) ramps up across the first `threshold` edges (peaking at the
  // threshold) then decays by day_decay per excess edge.
  let edgeContribution = 0;
  for (let d = 0; d < todaysEdges; d++) {
    const c = cycleEdgesBeforeDay + d;
    const cyc = Math.pow(settings.weakness_edge_cycle_decay, c);
    const intensity = edgeIntensityMultiplier(d, settings);
    edgeContribution += settings.weakness_edge_first * cyc * intensity;
  }
  const brutalMultiplier = computeBrutalBonusMultiplier(todaysEdges, settings);

  // --- Arousal (default when missing)
  const checkIn = checkIns.find((c) => c.date === date);
  const arousal =
    checkIn?.arousal ?? settings.default_arousal_when_missing;
  const arousalContribution = arousal * settings.weakness_arousal_weight;

  // --- Worship: minutes summed across all entries on this day
  const worshipMinutes = worship
    .filter((w) => w.date === date)
    .reduce((s, w) => s + (Number.isFinite(w.minutes) ? w.minutes : 0), 0);
  const worshipContribution = worshipMinutes * settings.worship_weight_per_minute;

  // --- Self-help: minutes summed
  const selfHelpMinutes = selfHelp
    .filter((s) => s.date === date)
    .reduce((s, sh) => s + (Number.isFinite(sh.minutes) ? sh.minutes : 0), 0);
  const selfHelpDetraction =
    selfHelpMinutes * settings.self_help_weight_per_minute;

  // --- Calorie detraction: max active calories across sources for the day,
  // threshold-gated then linear above. Apple Health rows are per (date, source)
  // so the same date can have multiple rows; take the max per the AppleHealth
  // dashboard helper convention.
  const ahRowsToday = appleHealth.filter((a) => a.date === date);
  const activeCalories = ahRowsToday.reduce(
    (m, a) => Math.max(m, a.activeCalories ?? 0),
    0
  );
  let calorieDetraction = 0;
  if (activeCalories >= settings.calorie_burn_threshold) {
    calorieDetraction =
      settings.calorie_burn_base_detraction +
      (activeCalories - settings.calorie_burn_threshold) *
        settings.calorie_burn_per_unit_above;
  }

  // --- Slip penalty: each lapsed orgasm logged on this date subtracts a
  // flat chunk. Cumulative score floors at 0, so a slip while still
  // climbing effectively resets the curve.
  const slipCount = orgasms.filter(
    (o) => o.date === date && o.type === "lapsed"
  ).length;
  const slipPenalty = slipCount * settings.slip_penalty_points;

  const gain =
    settings.weakness_base_daily +
    arousalContribution +
    edgeContribution +
    worshipContribution -
    selfHelpDetraction -
    calorieDetraction -
    slipPenalty;

  return {
    gain,
    edges: todaysEdges,
    arousal,
    brutalMultiplier,
    edgeContribution,
    arousalContribution,
    worshipContribution,
    worshipMinutes,
    selfHelpDetraction,
    selfHelpMinutes,
    calorieDetraction,
    activeCalories,
    slipCount,
    slipPenalty,
  };
}

// ---------- Cumulative score ----------

function addDays(iso: string, days: number): string {
  const ms = Date.parse(iso + "T00:00:00Z");
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

function diffDays(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  return Math.max(0, Math.round((b - a) / 86400000));
}

function findCycleStart(
  orgasms: OrgasmLogRow[],
  edges: EdgeLogRow[],
  checkIns: DailyCheckInRow[],
  today: string
): string {
  let lastAllowedDate: string | null = null;
  for (let i = orgasms.length - 1; i >= 0; i--) {
    if (orgasms[i].type === "allowed") {
      lastAllowedDate = orgasms[i].date;
      break;
    }
  }
  if (lastAllowedDate) {
    return addDays(lastAllowedDate, 1);
  }
  // No release on record — pick the earliest event date in the data, but
  // never go further back than 30 days so a brand-new sheet doesn't get
  // a wildly inflated score.
  const allDates: string[] = [];
  for (const e of edges) allDates.push(e.date);
  for (const c of checkIns) allDates.push(c.date);
  const earliest = allDates.length ? allDates.sort()[0] : today;
  const thirtyDaysAgo = addDays(today, -30);
  return earliest > thirtyDaysAgo ? earliest : thirtyDaysAgo;
}

/**
 * Walks each day from the day after the most recent ALLOWED orgasm through
 * `today`, accumulating signed daily gain and floored at 0. Heavy gym +
 * self-help days can pull the score down; a long denial run with edges
 * pushes it up.
 */
export function computeWeaknessScore(args: {
  orgasms: OrgasmLogRow[];
  edges: EdgeLogRow[];
  checkIns: DailyCheckInRow[];
  worship: WorshipLogRow[];
  selfHelp: SelfHelpLogRow[];
  appleHealth: AppleHealthRow[];
  settings: WeaknessSettings;
  today: string;
}): number {
  const { orgasms, edges, checkIns, worship, selfHelp, appleHealth, settings, today } = args;
  const startDate = findCycleStart(orgasms, edges, checkIns, today);
  if (startDate > today) return 0;
  const days = diffDays(startDate, today);
  let cycleEdgesBeforeDay = 0;
  let score = 0;
  for (let d = 0; d <= days; d++) {
    const date = addDays(startDate, d);
    const daily = computeDailyGain(
      date,
      edges,
      cycleEdgesBeforeDay,
      checkIns,
      worship,
      selfHelp,
      appleHealth,
      orgasms,
      settings
    );
    score += daily.gain;
    if (score < 0) score = 0;
    cycleEdgesBeforeDay += daily.edges;
  }
  return Math.round(score);
}

// ---------- 30-day series for the chart ----------

export type WeaknessSeriesPoint = {
  date: string;
  weakness: number;
  dailyGain: number;
  edges: number;
  phase: string;
  /**
   * Set to "peak" on the synthesized point that captures a slip day's
   * pre-slip cumulative score. The chart emits TWO points for any day
   * with a slip (peak first, then post-slip end-of-day) so the curve
   * preserves the high-water mark instead of letting the slip penalty
   * retroactively hide it.
   */
  slipMarker?: "peak";
};

/**
 * Build a 30-day weakness curve. We iterate cycle-from-start ONCE up to
 * `today` and capture the cumulative score at each step. Days before the
 * cycle start get score 0.
 */
export function build30DaySeries(args: {
  orgasms: OrgasmLogRow[];
  edges: EdgeLogRow[];
  checkIns: DailyCheckInRow[];
  worship: WorshipLogRow[];
  selfHelp: SelfHelpLogRow[];
  appleHealth: AppleHealthRow[];
  settings: WeaknessSettings;
  today: string;
}): WeaknessSeriesPoint[] {
  const { orgasms, edges, checkIns, worship, selfHelp, appleHealth, settings, today } = args;
  const startDate = findCycleStart(orgasms, edges, checkIns, today);
  const series: WeaknessSeriesPoint[] = [];
  // Build a date → cumulative score map by walking from cycle start.
  // preSlipScore captures what the cumulative WOULD have been without the
  // slip penalty applied — only differs from `score` on days with slips.
  const scoreByDate = new Map<
    string,
    {
      score: number;
      preSlipScore: number;
      daily: ReturnType<typeof computeDailyGain>;
    }
  >();
  if (startDate <= today) {
    const days = diffDays(startDate, today);
    let cycleEdgesBeforeDay = 0;
    let score = 0;
    for (let d = 0; d <= days; d++) {
      const date = addDays(startDate, d);
      const daily = computeDailyGain(
        date,
        edges,
        cycleEdgesBeforeDay,
        checkIns,
        worship,
        selfHelp,
        appleHealth,
        orgasms,
        settings
      );
      const prevScore = score;
      score += daily.gain;
      if (score < 0) score = 0;
      cycleEdgesBeforeDay += daily.edges;
      // Pre-slip score = previous cumulative + today's gain WITHOUT the
      // slip penalty (daily.gain already has it subtracted, so add it
      // back). Floored at 0 like the cumulative.
      const preSlipRaw = prevScore + daily.gain + daily.slipPenalty;
      const preSlipScore = Math.max(0, Math.round(preSlipRaw));
      scoreByDate.set(date, {
        score: Math.round(score),
        preSlipScore,
        daily,
      });
    }
  }
  for (let i = 29; i >= 0; i--) {
    const date = addDays(today, -i);
    const entry = scoreByDate.get(date);
    if (entry) {
      // Slip days: emit the pre-slip peak FIRST so the line spikes up
      // before dropping. Without this, end-of-day cumulative makes a
      // slip day look like the score never climbed.
      if (entry.daily.slipCount > 0 && entry.preSlipScore > entry.score) {
        const peakPhase = determinePhase(entry.preSlipScore, settings);
        series.push({
          date,
          weakness: entry.preSlipScore,
          dailyGain: Math.round(entry.daily.gain + entry.daily.slipPenalty),
          edges: entry.daily.edges,
          phase: peakPhase.name,
          slipMarker: "peak",
        });
      }
      const phase = determinePhase(entry.score, settings);
      series.push({
        date,
        weakness: entry.score,
        dailyGain: Math.round(entry.daily.gain),
        edges: entry.daily.edges,
        phase: phase.name,
      });
    } else {
      // Pre-cycle: zeroed point, kept so the chart x-axis stays uniform.
      series.push({
        date,
        weakness: 0,
        dailyGain: 0,
        edges: 0,
        phase: determinePhase(0, settings).name,
      });
    }
  }
  return series;
}

// ---------- Dashboard aggregator ----------

export type WeaknessDashboardData = {
  daysDenied: number;
  totalEdgesSinceLast: number;
  totalEdgesEver: number;
  todayEdges: number;
  weaknessScore: number;
  todayDailyGain: number;
  todayBrutalMultiplier: number;
  todayWorshipMinutes: number;
  todayWorshipContribution: number;
  todaySelfHelpMinutes: number;
  todaySelfHelpDetraction: number;
  todayActiveCalories: number;
  todayCalorieDetraction: number;
  currentPhase: PhaseInfo;
  thirtyDaySeries: WeaknessSeriesPoint[];
  orgasmAllowed: "yes" | "no";
  mostRecentOrgasm: { date: string; type: "allowed" | "lapsed" } | null;
  hasArousalCheckInToday: boolean;
  configured: boolean;
};

/**
 * One-shot fetch + compute for the dashboard tile. Reads everything from
 * Sheets via getWeaknessRawData(), then runs the pure compute locally.
 */
export async function getDashboardWeakness(): Promise<WeaknessDashboardData> {
  const today = todaySydneyISO();
  let raw;
  try {
    raw = await getWeaknessRawData();
  } catch {
    // Sheet not configured — return a zeroed shell so the page still renders.
    return emptyDashboard(today);
  }
  const {
    orgasms,
    edges,
    checkIns,
    worship,
    selfHelp,
    appleHealth,
    settings,
    hasArousalCheckInToday,
    mostRecentOrgasm,
  } = raw;

  // Auto-release: when the denial countdown expires, flip orgasm_allowed
  // from "no" to "yes". Triggers on dashboard load — idempotent because
  // the guard short-circuits once the flip has happened. denial_end_date
  // is left in place so the past target stays visible in the Sheet; the
  // inline DenialClock collapses the countdown automatically once the
  // target has passed.
  const denialEnd = await getDenialEndDate();
  if (settings.orgasm_allowed === "no" && denialEnd) {
    const targetMs = Date.parse(denialEnd);
    if (!isNaN(targetMs) && targetMs <= Date.now()) {
      try {
        await setSetting("orgasm_allowed", "yes", "auto-release");
        settings.orgasm_allowed = "yes";
      } catch (e) {
        // Don't block the dashboard render if the write fails.
        console.error("[weakness] auto-release setSetting failed:", (e as Error).message);
      }
    }
  }

  const score = computeWeaknessScore({
    orgasms,
    edges,
    checkIns,
    worship,
    selfHelp,
    appleHealth,
    settings,
    today,
  });

  // Today's gain breakdown — for tile display we need the cumulative cycle
  // edges going INTO today, not from-zero.
  const startDate = findCycleStart(orgasms, edges, checkIns, today);
  const cycleEdgesBeforeToday = edges.filter(
    (e) => e.date >= startDate && e.date < today
  ).length;
  const daily = computeDailyGain(
    today,
    edges,
    cycleEdgesBeforeToday,
    checkIns,
    worship,
    selfHelp,
    appleHealth,
    orgasms,
    settings
  );
  const phase = determinePhase(score, settings);
  const series = build30DaySeries({
    orgasms,
    edges,
    checkIns,
    worship,
    selfHelp,
    appleHealth,
    settings,
    today,
  });

  const daysDenied = mostRecentOrgasm ? diffDays(mostRecentOrgasm.date, today) : 0;
  // Edges since the most recent orgasm (any type). Same logic as the sheet
  // helper but computed in-memory off the data we already have.
  const cutoff = mostRecentOrgasm
    ? `${mostRecentOrgasm.date}T${mostRecentOrgasm.time || "00:00"}`
    : "";
  const totalEdgesSinceLast = mostRecentOrgasm
    ? edges.filter((e) => `${e.date}T${e.time || "00:00"}` > cutoff).length
    : edges.length;

  return {
    daysDenied,
    totalEdgesSinceLast,
    totalEdgesEver: edges.length,
    todayEdges: daily.edges,
    weaknessScore: score,
    todayDailyGain: Math.round(daily.gain),
    todayBrutalMultiplier: daily.brutalMultiplier,
    todayWorshipMinutes: daily.worshipMinutes,
    todayWorshipContribution: Math.round(daily.worshipContribution),
    todaySelfHelpMinutes: daily.selfHelpMinutes,
    todaySelfHelpDetraction: Math.round(daily.selfHelpDetraction),
    todayActiveCalories: daily.activeCalories,
    todayCalorieDetraction: Math.round(daily.calorieDetraction),
    currentPhase: phase,
    thirtyDaySeries: series,
    orgasmAllowed: settings.orgasm_allowed,
    mostRecentOrgasm: mostRecentOrgasm
      ? { date: mostRecentOrgasm.date, type: mostRecentOrgasm.type }
      : null,
    hasArousalCheckInToday,
    configured: true,
  };
}

function emptyDashboard(_today: string): WeaknessDashboardData {
  void _today;
  return {
    daysDenied: 0,
    totalEdgesSinceLast: 0,
    totalEdgesEver: 0,
    todayEdges: 0,
    weaknessScore: 0,
    todayDailyGain: 0,
    todayBrutalMultiplier: 1,
    todayWorshipMinutes: 0,
    todayWorshipContribution: 0,
    todaySelfHelpMinutes: 0,
    todaySelfHelpDetraction: 0,
    todayActiveCalories: 0,
    todayCalorieDetraction: 0,
    currentPhase: {
      name: "Unconfigured",
      flavorText: "Set up the Sheet to start tracking.",
      currentRangeMin: 0,
      currentRangeMax: 0,
      nextPhaseName: null,
      nextPhaseThreshold: null,
      percentToNext: 0,
    },
    thirtyDaySeries: [],
    orgasmAllowed: "no",
    mostRecentOrgasm: null,
    hasArousalCheckInToday: false,
    configured: false,
  };
}
