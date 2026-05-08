/**
 * One-shot helper that backfills the new Weakness-Altar Settings keys
 * into the existing Settings tab. Idempotent — uses setSetting() which
 * upserts on `Setting` column.
 *
 * Usage (from project root, with .env.local populated):
 *   npx tsx scripts/seed-weakness-settings.ts
 *
 * Safe to re-run. Only writes rows that DIFFER from the new defaults
 * baked into DEFAULT_WEAKNESS_SETTINGS at the time of writing the
 * script. Existing rows for old keys (weakness_edge_weight,
 * brutal_bonus_per_10_edges) are left in place — the new code ignores
 * them and you can delete them from the Sheet UI if you want it tidy.
 */
import { readFileSync } from "node:fs";
function loadDotEnvLocal(path = ".env.local"): void {
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
    if (!m) continue;
    process.env[m[1]] = m[2];
  }
}
loadDotEnvLocal();

import {
  DEFAULT_WEAKNESS_SETTINGS,
  isConfigured,
  setSetting,
} from "../src/lib/sheets";

const NEW_KEYS: Array<keyof typeof DEFAULT_WEAKNESS_SETTINGS> = [
  "weakness_edge_first",
  "weakness_edge_cycle_decay",
  "weakness_edge_day_decay",
  "brutal_bonus_per_edge",
  "brutal_bonus_post_plateau_linear",
  "calorie_burn_threshold",
  "calorie_burn_base_detraction",
  "calorie_burn_per_unit_above",
  "worship_weight_per_minute",
  "self_help_weight_per_minute",
  "slip_penalty_points",
];

async function main() {
  if (!isConfigured()) {
    console.error(
      "Missing env vars. Need GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID in .env.local."
    );
    process.exit(1);
  }
  console.log(`Seeding ${NEW_KEYS.length} new Settings keys…`);
  for (const key of NEW_KEYS) {
    const value = DEFAULT_WEAKNESS_SETTINGS[key] as number;
    await setSetting(key, value, "seed-weakness-settings");
    console.log(`  ${key} = ${value}`);
  }
  console.log("Done. Updated keys are now tunable from the Settings tab.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
