/**
 * One-time setup script. Run AFTER:
 *   1. The service account has been created.
 *   2. You have shared the Sheet (SHEET_ID) with that service account
 *      email at "Editor" level.
 *   3. .env.local has GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID set.
 *
 * Usage:
 *   npx tsx scripts/init-sheet.ts
 *
 * Idempotent: re-running only adds missing tabs / does not overwrite data.
 */
// Custom .env.local loader. The default `dotenv` package (and node's
// --env-file flag) parses the GOOGLE_SERVICE_ACCOUNT_JSON value
// incorrectly because Vercel CLI writes the JSON with unescaped inner
// double quotes — dotenv terminates the value at the first inner ".
// We read the file ourselves: `KEY="..."` per line, value taken as-is.
import { readFileSync } from "node:fs";
function loadDotEnvLocal(path = ".env.local"): void {
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
    if (!m) continue;
    // Always overwrite — tsx auto-loading may have populated truncated
    // values from misparsing the JSON entry's unescaped inner quotes.
    process.env[m[1]] = m[2];
  }
}
loadDotEnvLocal();

import {
  ensureTabs,
  appendRows,
  isConfigured,
  SETTINGS_SEED_ROWS,
} from "../src/lib/sheets";

async function main() {
  if (!isConfigured()) {
    console.error(
      "Missing env vars. Need GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID in .env.local."
    );
    process.exit(1);
  }

  console.log("Ensuring tabs exist…");
  const { created, existing } = await ensureTabs();
  console.log(`  created: [${created.join(", ") || "(none)"}]`);
  console.log(`  existing: [${existing.join(", ") || "(none)"}]`);

  // Seed data only if Tasks/Punishments were just created (don't clobber).
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() - 2 * 86400 * 1000)
    .toISOString()
    .slice(0, 10);

  if (created.includes("Tasks")) {
    console.log("Seeding Tasks…");
    await appendRows("Tasks", [
      [today, "30 min cardio", "Coach", "", "", ""],
      [today, "Hit protein 140g", "Coach", "", "", ""],
      [today, "Submit proof video", "Coach", "", "", ""],
      [yest, "Pay outstanding $45", "Coach", "yes", `${yest} 19:30`, ""],
    ]);
  }

  if (created.includes("Punishments")) {
    console.log("Seeding Punishments…");
    await appendRows("Punishments", [
      [dayBefore, 10, "Late wake (06:18)", "Coach", "no"],
      [yest, 45, "Phone over 90min", "Coach", "no"],
      [today, 30, "Missed writing target", "Coach", "no"],
    ]);
  }

  if (created.includes("Daily Log")) {
    console.log("Seeding Daily Log…");
    await appendRows("Daily Log", [
      [today, "", "", "06:08", "", "", 78],
    ]);
  }

  if (created.includes("Coach Notes")) {
    console.log("Seeding Coach Notes…");
    await appendRows("Coach Notes", [
      [today, "Coach", "Strong work yesterday. Keep it up."],
    ]);
  }

  if (created.includes("Settings")) {
    console.log("Seeding Settings…");
    await appendRows("Settings", SETTINGS_SEED_ROWS);
  }

  if (created.includes("Denial")) {
    console.log("Seeding Denial config…");
    await appendRows("Denial", [
      ["denial_end_date", ""],
    ]);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
