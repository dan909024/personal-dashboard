/**
 * Deletes the seed/demo rows from the live Punishments tab.
 *
 * The three rows originally written by scripts/init-sheet.ts:
 *   - "Late wake (06:18)"          ($10, Coach)
 *   - "Phone over 90min"           ($45, Coach)
 *   - "Missed writing target"      ($30, Coach)
 *
 * Also matches the same reasons after the Phase 1 rename
 * (`DEMO — <reason>`), in case init-sheet.ts was ever re-run with the
 * updated seed.
 *
 * Usage:
 *   npx tsx scripts/cleanup-demo-punishments.ts            # dry-run (default)
 *   npx tsx scripts/cleanup-demo-punishments.ts --apply    # actually delete
 *
 * Idempotent: re-running after delete is a no-op (nothing to match).
 */
// IPv4-only HTTPS agent — on this Mac, IPv6 routing to googleapis.com hangs
// for the full timeout instead of failing fast. `dns-result-order=ipv4first`
// alone doesn't help; Node's dual-stack still tries v6. Forcing family:4 on
// the global agent is the smallest fix that works. Use require() so the
// reassignment lands on the module's mutable globalAgent slot.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const httpsMod = require("node:https") as typeof import("node:https");
httpsMod.globalAgent = new httpsMod.Agent({ family: 4, keepAlive: true });

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

import { google } from "googleapis";
import { isConfigured, loadServiceAccountCreds } from "../src/lib/sheets";

const DEMO_REASON_PATTERNS = [
  /^(DEMO\s*[—-]\s*)?Late wake\b/i,
  /^(DEMO\s*[—-]\s*)?Phone over 90min\b/i,
  /^(DEMO\s*[—-]\s*)?Missed writing target\b/i,
];

const DEMO_AMOUNTS = new Set([10, 45, 30]);

async function main() {
  const apply = process.argv.includes("--apply");
  if (!isConfigured()) {
    console.error("Missing env: GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID required.");
    process.exit(1);
  }
  const sheetId = process.env.SHEET_ID || "";
  const auth = new google.auth.GoogleAuth({
    credentials: loadServiceAccountCreds(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Find the Punishments sheet's numeric sheetId for deleteDimension.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const punishments = (meta.data.sheets || []).find(
    (s) => s.properties?.title === "Punishments"
  );
  if (!punishments?.properties?.sheetId === undefined || !punishments) {
    console.error('Punishments tab not found.');
    process.exit(1);
  }
  const punishmentsSheetId = punishments.properties!.sheetId!;

  // Read all rows.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Punishments!A1:F",
  });
  const rows = (res.data.values || []) as string[][];
  if (rows.length < 2) {
    console.log("No data rows to inspect.");
    return;
  }

  const matches: { rowIndex: number; row: string[] }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const amount = Number(String(r[1] ?? "").replace(/[^0-9.\-]/g, "")) || 0;
    const reason = String(r[2] ?? "").trim();
    const setBy = String(r[3] ?? "").trim();
    const reasonMatches = DEMO_REASON_PATTERNS.some((re) => re.test(reason));
    if (!reasonMatches) continue;
    if (!DEMO_AMOUNTS.has(amount)) continue;
    if (setBy.toLowerCase() !== "coach") continue;
    matches.push({ rowIndex: i, row: r });
  }

  console.log(`Found ${matches.length} demo row(s):`);
  for (const m of matches) {
    console.log(
      `  row ${m.rowIndex + 1}: ${m.row[0]} | $${m.row[1]} | "${m.row[2]}" | ${m.row[3]}`
    );
  }

  if (matches.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to delete these rows.");
    return;
  }

  // Delete rows highest-index first so earlier indices stay valid.
  const requests = matches
    .slice()
    .sort((a, b) => b.rowIndex - a.rowIndex)
    .map((m) => ({
      deleteDimension: {
        range: {
          sheetId: punishmentsSheetId,
          dimension: "ROWS",
          startIndex: m.rowIndex, // 0-based; matches A1 row m.rowIndex+1
          endIndex: m.rowIndex + 1,
        },
      },
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });

  console.log(`\nDeleted ${matches.length} row(s) from Punishments.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
