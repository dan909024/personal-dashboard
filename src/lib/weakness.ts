/**
 * Phase 5B — Goddess's Weakening Altar
 *
 * Pure compute: phase progression, weakness score, brutal-day bonus, 30-day
 * series. Read sheet rows + settings from src/lib/sheets.ts and pass them in;
 * nothing here touches the network. Tunable from the Settings tab without
 * touching the tile.
 */
import {
  todaySydneyISO,
  getWeaknessRawData,
  getDenialEndDate,
  setSetting,
  type DailyCheckInRow,
  type EdgeLogRow,
  type OrgasmLogRow,
  type WeaknessSettings,
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

// ---------- Daily gain ----------

export function computeBrutalBonusMultiplier(
  todaysEdges: number,
  settings: WeaknessSettings
): number {
  if (todaysEdges <= settings.brutal_bonus_threshold) return 1.0;
  const excess = todaysEdges - settings.brutal_bonus_threshold;
  const multiplier =
    1.0 + Math.floor(excess / 10) * settings.brutal_bonus_per_10_edges;
  return Math.min(multiplier, settings.brutal_bonus_max_multiplier);
}

export function computeDailyGain(
  date: string,
  edgeLogs: EdgeLogRow[],
  checkIns: DailyCheckInRow[],
  settings: WeaknessSettings
): { gain: number; edges: number; arousal: number; brutalMultiplier: number } {
  const todaysEdges = edgeLogs.filter((e) => e.date === date).length;
  const checkIn = checkIns.find((c) => c.date === date);
  const todaysArousal =
    checkIn?.arousal ?? settings.default_arousal_when_missing;
  const base = settings.weakness_base_daily;
  const edgeContribution = todaysEdges * settings.weakness_edge_weight;
  const arousalContribution = todaysArousal * settings.weakness_arousal_weight;
  const brutalMultiplier = computeBrutalBonusMultiplier(todaysEdges, settings);
  const gain = (base + edgeContribution + arousalContribution) * brutalMultiplier;
  return { gain, edges: todaysEdges, arousal: todaysArousal, brutalMultiplier };
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

/**
 * Walks each day from the most recent ALLOWED orgasm (inclusive of the day
 * AFTER it) through `today`, accumulating daily gain. If no allowed orgasm
 * exists yet, starts from the earliest event date in the data set, or 30
 * days ago — whichever is more recent — to keep the score bounded for
 * fresh installs.
 */
export function computeWeaknessScore(args: {
  orgasms: OrgasmLogRow[];
  edges: EdgeLogRow[];
  checkIns: DailyCheckInRow[];
  settings: WeaknessSettings;
  today: string;
}): number {
  const { orgasms, edges, checkIns, settings, today } = args;
  let lastAllowedDate: string | null = null;
  for (let i = orgasms.length - 1; i >= 0; i--) {
    if (orgasms[i].type === "allowed") {
      lastAllowedDate = orgasms[i].date;
      break;
    }
  }
  let startDate: string;
  if (lastAllowedDate) {
    // Start the day AFTER the allowed orgasm — release-day itself is zeroed.
    startDate = addDays(lastAllowedDate, 1);
  } else {
    // No release on record — pick the earliest event date in the data, but
    // never go further back than 30 days so a brand-new sheet doesn't get
    // a wildly inflated score.
    const allDates: string[] = [];
    for (const e of edges) allDates.push(e.date);
    for (const c of checkIns) allDates.push(c.date);
    const earliest = allDates.length ? allDates.sort()[0] : today;
    const thirtyDaysAgo = addDays(today, -30);
    startDate = earliest > thirtyDaysAgo ? earliest : thirtyDaysAgo;
  }
  if (startDate > today) return 0;
  const days = diffDays(startDate, today);
  let score = 0;
  for (let d = 0; d <= days; d++) {
    const date = addDays(startDate, d);
    score += computeDailyGain(date, edges, checkIns, settings).gain;
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
 * Build a 30-day weakness curve. Each point is the cumulative score AS OF
 * that day, computed with the same start-date logic as computeWeaknessScore
 * so the curve resets at allowed orgasms.
 */
export function build30DaySeries(args: {
  orgasms: OrgasmLogRow[];
  edges: EdgeLogRow[];
  checkIns: DailyCheckInRow[];
  settings: WeaknessSettings;
  today: string;
}): WeaknessSeriesPoint[] {
  const { orgasms, edges, checkIns, settings, today } = args;
  const out: WeaknessSeriesPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = addDays(today, -i);
    const score = computeWeaknessScore({
      orgasms,
      edges,
      checkIns,
      settings,
      today: date,
    });
    const daily = computeDailyGain(date, edges, checkIns, settings);
    const phase = determinePhase(score, settings);
    out.push({
      date,
      weakness: score,
      dailyGain: Math.round(daily.gain),
      edges: daily.edges,
      phase: phase.name,
    });
  }
  return out;
}

// ---------- Dashboard aggregator ----------

export type WeaknessDashboardData = {
  daysDenied: number;
  totalEdgesSinceLast: number;
  todayEdges: number;
  weaknessScore: number;
  todayDailyGain: number;
  todayBrutalMultiplier: number;
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
  const { orgasms, edges, checkIns, settings, hasArousalCheckInToday, mostRecentOrgasm } = raw;

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

  const score = computeWeaknessScore({ orgasms, edges, checkIns, settings, today });
  const daily = computeDailyGain(today, edges, checkIns, settings);
  const phase = determinePhase(score, settings);
  const series = build30DaySeries({ orgasms, edges, checkIns, settings, today });

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
