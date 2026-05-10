/**
 * Rule registry — links the Harley Meter rules in `harley-meter.ts` to
 * the `Rule` column on the Punishments sheet so each fine can be
 * traced back to the rule it came from.
 *
 * Used in two places:
 *   1. Dashboard — OWED HARLEY tile renders a tooltip with the rule's
 *      human-readable label and source when a fine has a rule_id.
 *   2. Telegram /fine command — manual fines pass an empty rule_id so
 *      the tooltip surfaces "Manual fine, set by Harley" instead.
 *
 * Phase 2 TODO: a daily cron will read Harley Meter inputs and append
 * Punishments rows automatically, stamped with the matching rule_id.
 * Until then every row in this registry exists for tooltip provenance
 * only.
 */
export type HarleyRuleId =
  | "wake"
  | "bed"
  | "gym"
  | "steps"
  | "water"
  | "strain"
  | "writing"
  | "screentime"
  | "protein"
  | "worship"
  | "edges"
  | "drinking"
  | "slip";

export type HarleyRule = {
  id: HarleyRuleId;
  label: string;
  source: string;
};

export const HARLEY_RULES: Record<HarleyRuleId, HarleyRule> = {
  wake: { id: "wake", label: "Wake by 06:00", source: "Whoop sleep onset" },
  bed: { id: "bed", label: "Bed by 22:30", source: "Whoop sleep start" },
  gym: { id: "gym", label: "Gym 4+ /week", source: "Whoop Workouts" },
  steps: { id: "steps", label: "70k steps /week", source: "Apple Health" },
  water: { id: "water", label: "3.3 L water /day avg", source: "Apple Health · dietaryWater" },
  strain: { id: "strain", label: "Strain ≥12 on training days", source: "Whoop daily strain" },
  writing: { id: "writing", label: "Writing 8+ hr /week", source: "Obsidian foreground time (Screen Time)" },
  screentime: { id: "screentime", label: "Screen Time within bucket targets", source: "Screen Time daily totals (YouTube/Instagram/Dating)" },
  protein: { id: "protein", label: "Protein 5+ days /week", source: "Apple Health · dietaryProtein" },
  worship: { id: "worship", label: "Daily worship target", source: "Worship Log · daily target slider" },
  edges: { id: "edges", label: "Daily edges target", source: "Edge Log · daily target slider" },
  drinking: { id: "drinking", label: "Drank alcohol", source: "Telegram /drank · panel button (manual)" },
  slip: { id: "slip", label: "Cumming without permission", source: "WeaknessAltar Slipped button" },
};

/**
 * Default per-rule fine amount in AUD. Acts as the fallback when the matching
 * `fine_amount_<id>` row is missing from Settings. Live amounts are read via
 * `getFineAmounts()` in rule-eval.ts and can be edited from the Harley panel.
 *
 * `worship` and `edges` default to $0 — the rules have scorers wired into the
 * cron but won't fine until Harley sets both an amount AND a daily target via
 * the Daily targets sliders on the panel. Setting amount > 0 alone isn't
 * enough; the target slider must also be > 0.
 */
export const DEFAULT_FINE_AMOUNTS: Record<HarleyRuleId, number> = {
  wake: 10,
  bed: 15,
  gym: 25,
  steps: 10,
  water: 20,
  strain: 15,
  writing: 30,
  screentime: 10,
  protein: 20,
  worship: 0,
  edges: 0,
  drinking: 100,
  slip: 20,
};

/** Settings key Harley edits to override a rule's default fine amount. */
export function fineAmountSettingKey(ruleId: HarleyRuleId): string {
  return `fine_amount_${ruleId}`;
}

export function lookupRule(ruleId: string | undefined): HarleyRule | null {
  if (!ruleId) return null;
  const r = HARLEY_RULES[ruleId as HarleyRuleId];
  return r ?? null;
}
