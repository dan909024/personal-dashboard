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

// ---------- Brutal multiplier (zone 2 of edge curve) ----------

export function computeBrutalBonusMultiplier(
  todaysEdges: number,
  settings: WeaknessSettings
): number {
  if (todaysEdges <= settings.brutal_bonus_threshold) return 1.0;
  const excess = todaysEdges - settings.brutal_bonus_threshold;
  const multiplier = 1.0 + excess * settings.brutal_bonus_per_edge;
  return Math.min(multiplier, settings.brutal_bonus_max_multiplier);
}

/**
 * Day-edge count above which the brutal multiplier hits its cap. Past this
 * count, every additional edge adds a flat linear amount (zone 3 of the
 * edge curve) instead of multiplying further.
 */
function multiplierPlateauCount(settings: WeaknessSettings): number {
  if (settings.brutal_bonus_per_edge <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const excessAtCap =
    (settings.brutal_bonus_max_multiplier - 1.0) /
    settings.brutal_bonus_per_edge;
  return settings.brutal_bonus_threshold + excessAtCap;
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
  settings: WeaknessSettings
): DailyGain {
  const todaysEdges = edgeLogs.filter((e) => e.date === date).length;

  // --- Edge curve: zone 1 (diminished) + zone 2 (multiplier) + zone 3 (linear plateau)
  let diminishedSum = 0;
  for (let d = 0; d < todaysEdges; d++) {
    const c = cycleEdgesBeforeDay + d;
    const cyc = Math.pow(settings.weakness_edge_cycle_decay, c);
    const day = Math.pow(settings.weakness_edge_day_decay, d);
    diminishedSum += settings.weakness_edge_first * cyc * day;
  }
  const brutalMultiplier = computeBrutalBonusMultiplier(todaysEdges, settings);
  const plateauCount = multiplierPlateauCount(settings);
  const plateauEdges = Math.max(0, todaysEdges - plateauCount);
  const plateauLinear = plateauEdges * settings.brutal_bonus_post_plateau_linear;
  const edgeContribution = diminishedSum * brutalMultiplier + plateauLinear;

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

  const gain =
    settings.weakness_base_daily +
    arousalContribution +
    edgeContribution +
    worshipContribution -
    selfHelpDetraction -
    calorieDetraction;

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
  const scoreByDate = new Map<string, { score: number; daily: ReturnType<typeof computeDailyGain> }>();
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
        settings
      );
      score += daily.gain;
      if (score < 0) score = 0;
      cycleEdgesBeforeDay += daily.edges;
      scoreByDate.set(date, { score: Math.round(score), daily });
    }
  }
  for (let i = 29; i >= 0; i--) {
    const date = addDays(today, -i);
    const entry = scoreByDate.get(date);
    if (entry) {
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
