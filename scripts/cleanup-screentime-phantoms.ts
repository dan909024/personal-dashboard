/**
 * One-shot cleanup: remove "phantom" mac_ui_iphone rows from the
 * Screen Time tab.
 *
 * Background: while iterating on the iPhone UI scraper, several runs
 * posted bad data (captured "All Devices" totals while labelled as
 * iPhone). Those rows are still in the Sheet. The dashboard's
 * dedup-per-(date, source, label) keeps the LATEST row by syncedAt,
 * so a corrected re-post overwrites bad rows for the SAME app — but
 * apps that appeared in a bad post and DON'T appear in the corrected
 * post (e.g. inflated "WhatsApp 33m" from All-Devices that doesn't
 * match real iPhone usage) leave their old bad rows in place.
 *
 * This script:
 *   1. Reads all rows from "Screen Time" tab.
 *   2. Marks for deletion any mac_ui_iphone row that's EITHER:
 *        a) older than the latest syncedAt for its date (phantom from
 *           an earlier broken scrape); OR
 *        b) contains a personal-identifier token that the runtime
 *           redactor in screentime-ui-sync.ts would now reject. See
 *           memory: feedback_personal_identifier_redaction.md.
 *           (Website-domain rows like loyalfans.com are NOT filtered
 *           — only labels matching the personal-identifier regex.)
 *   3. By default DRY-RUN: prints what would be deleted.
 *   4. With --execute: deletes via Sheets batchUpdate (deleteDimension
 *      from bottom up so indices stay stable).
 *
 * Usage:
 *   npx tsx scripts/cleanup-screentime-phantoms.ts             # dry run
 *   npx tsx scripts/cleanup-screentime-phantoms.ts --execute    # actually delete
 *   npx tsx scripts/cleanup-screentime-phantoms.ts --date 2026-05-09 --execute
 *
 * Default scope: all dates present in the sheet for source=mac_ui_iphone.
 * Restrict with --date YYYY-MM-DD if you only want one day.
 */
// Load .env.local manually — Vercel's CLI writes the SA JSON with
// unescaped inner quotes that break the default dotenv parser. Mirror
// scripts/init-sheet.ts's loader.
import { readFileSync, existsSync } from "node:fs";
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv(".env.local");

import { google, sheets_v4 } from "googleapis";

const SHEET_ID = process.env.SHEET_ID || process.env.GOOGLE_SHEET_ID || "";
const SA_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const TARGET_SOURCE = "mac_ui_iphone";

if (!SHEET_ID) {
  console.error("Missing SHEET_ID env (or GOOGLE_SHEET_ID).");
  process.exit(1);
}
if (!SA_RAW) {
  console.error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env.");
  process.exit(1);
}

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const dateArgIdx = args.indexOf("--date");
const ONLY_DATE =
  dateArgIdx >= 0 && args[dateArgIdx + 1] ? args[dateArgIdx + 1] : null;

function sheetsClient(): sheets_v4.Sheets {
  const creds = JSON.parse(SA_RAW);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// Mirror the runtime redaction filter from screentime-ui-sync.ts so
// the cleanup also wipes historical rows that the filter would now
// reject. Keep these in sync — see
// feedback_personal_identifier_redaction.md.
const PERSONAL_REDACT_REGEX =
  /\b(avid|pubsuite|daniel|ferrari)(['’]s)?\b/i;

function redactionReason(label: string): string | null {
  if (PERSONAL_REDACT_REGEX.test(label)) return "personal_identifier";
  return null;
}

async function findScreenTimeSheetId(client: sheets_v4.Sheets): Promise<number> {
  const meta = await client.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties?.title === "Screen Time"
  );
  if (!sheet || sheet.properties?.sheetId == null) {
    throw new Error("'Screen Time' tab not found in spreadsheet");
  }
  return sheet.properties.sheetId;
}

async function main() {
  const client = sheetsClient();
  const sheetGid = await findScreenTimeSheetId(client);

  const res = await client.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Screen Time!A1:F",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values || []) as (string | number)[][];
  if (rows.length < 2) {
    console.log("No data rows in Screen Time tab.");
    return;
  }

  // Index (1-based row number, since header is row 1) → row data
  type Row = {
    rowNum: number; // 1-based; row 2 is the first data row
    date: string;
    source: string;
    label: string;
    minutes: number;
    syncedAt: string;
  };
  const all: Row[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    all.push({
      rowNum: i + 1,
      date: String(r[0] ?? ""),
      source: String(r[1] ?? ""),
      label: String(r[2] ?? ""),
      minutes: Number(r[4] ?? 0) || 0,
      syncedAt: String(r[5] ?? ""),
    });
  }

  // Filter to target source (and optionally a single date).
  const targetRows = all.filter(
    (r) =>
      r.source === TARGET_SOURCE &&
      (!ONLY_DATE || r.date === ONLY_DATE)
  );
  if (targetRows.length === 0) {
    console.log(
      `No ${TARGET_SOURCE} rows found${ONLY_DATE ? ` for ${ONLY_DATE}` : ""}.`
    );
    return;
  }

  // Group by date, find the latest syncedAt per date — those are the
  // "good batch" rows to keep.
  const latestByDate = new Map<string, string>();
  for (const r of targetRows) {
    const cur = latestByDate.get(r.date);
    if (!cur || r.syncedAt > cur) latestByDate.set(r.date, r.syncedAt);
  }

  // Phantom rows: anything older than the latest syncedAt for its date.
  // PLUS any row (latest or not) whose label matches the personal-
  // identifier filter in screentime-ui-sync.ts — these are the
  // historical name-leaking rows that landed before the filter was
  // added. (See feedback_personal_identifier_redaction.) Website rows
  // are intentionally kept — only personal-identifier matches drop.
  const toDelete = targetRows.filter((r) => {
    const isOlderBatch = r.syncedAt !== latestByDate.get(r.date);
    const isBadLabel = redactionReason(r.label) !== null;
    return isOlderBatch || isBadLabel;
  });
  const toKeep = targetRows.filter((r) => !toDelete.includes(r));

  console.log(
    `Source=${TARGET_SOURCE} ${ONLY_DATE ? `date=${ONLY_DATE}` : "(all dates)"}`
  );
  console.log(
    `  total rows: ${targetRows.length}, keeping: ${toKeep.length}, deleting: ${toDelete.length}`
  );
  console.log(`  latest syncedAt per date:`);
  for (const [date, ts] of latestByDate) {
    console.log(`    ${date}: ${ts}`);
  }

  if (toDelete.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  console.log("\nSample rows to delete (up to 10):");
  for (const r of toDelete.slice(0, 10)) {
    console.log(
      `  row ${r.rowNum}: ${r.date} ${r.label} ${r.minutes}m (synced ${r.syncedAt})`
    );
  }

  if (!EXECUTE) {
    console.log("\nDRY RUN. Re-run with --execute to actually delete.");
    return;
  }

  // Delete bottom-up so row indices stay stable as we delete.
  // Sheets API deleteDimension: rowNum is 1-based for users but the
  // API uses 0-based startIndex (inclusive) and endIndex (exclusive).
  // So row 5 (1-based) = startIndex 4, endIndex 5.
  const sortedDesc = [...toDelete].sort((a, b) => b.rowNum - a.rowNum);
  const requests: sheets_v4.Schema$Request[] = sortedDesc.map((r) => ({
    deleteDimension: {
      range: {
        sheetId: sheetGid,
        dimension: "ROWS",
        startIndex: r.rowNum - 1,
        endIndex: r.rowNum,
      },
    },
  }));

  await client.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests },
  });
  console.log(`\nDeleted ${toDelete.length} rows.`);
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(99);
});
