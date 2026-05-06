/**
 * Mac Screen Time collector.
 *
 * Reads ~/Library/Application Support/com.apple.RemoteManagementAgent/Database/
 * RemoteManagement.sqlite — the cross-device Screen Time database
 * (includes iPhone usage when "Share Across Devices" is on) — aggregates
 * per-app per-day minutes for the last N days, and POSTs to the
 * dashboard's screentime ingest endpoint.
 *
 * Designed to run from launchd every few hours. Idempotent: re-posting
 * the same day produces additional rows but readers dedupe to latest by
 * syncedAt. Default lookback is 3 days so a closed-laptop weekend can
 * still backfill on next wake.
 *
 * Run manually:
 *   SCREENTIME_INGEST_URL=https://<your-vercel>/api/screentime/ingest \
 *   SCREENTIME_INGEST_SECRET=... \
 *   npx tsx scripts/screentime-mac-sync.ts
 *
 * Env vars:
 *   SCREENTIME_INGEST_URL    Required. Full URL to the ingest endpoint.
 *   SCREENTIME_INGEST_SECRET Required. Shared secret with the server.
 *   SCREENTIME_LOOKBACK_DAYS Optional, default 3.
 *   SCREENTIME_TZ            Optional, default Australia/Sydney.
 *
 * IMPORTANT: the SQL in `SCREENTIME_QUERY` is a placeholder. The schema
 * of RemoteManagement.sqlite is undocumented and varies by macOS
 * version. Run scripts/screentime-discover.sh first to see what tables
 * and columns exist on YOUR machine, then replace the placeholder query
 * with one that returns rows in the shape the rest of this script
 * expects. Search for "SCHEMA TODO" below.
 */
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ---------- Config ----------

const DB_PATH =
  process.env.SCREENTIME_DB_PATH ||
  join(
    homedir(),
    "Library/Application Support/com.apple.RemoteManagementAgent/Database/RemoteManagement.sqlite"
  );
const INGEST_URL = process.env.SCREENTIME_INGEST_URL || "";
const INGEST_SECRET = process.env.SCREENTIME_INGEST_SECRET || "";
const LOOKBACK_DAYS = Math.max(
  1,
  Math.min(30, Number(process.env.SCREENTIME_LOOKBACK_DAYS) || 3)
);
const TZ = process.env.SCREENTIME_TZ || "Australia/Sydney";
const SOURCE = "mac_launchd";

if (!INGEST_URL || !INGEST_SECRET) {
  console.error(
    "Missing SCREENTIME_INGEST_URL or SCREENTIME_INGEST_SECRET. Set them in the launchd plist (or your shell) before running."
  );
  process.exit(1);
}

if (!existsSync(DB_PATH)) {
  console.error(`Screen Time DB not found at ${DB_PATH}.`);
  console.error(
    "Open Settings → Screen Time on this Mac to enable it, and 'Share Across Devices' on iPhone if you want iOS apps included."
  );
  process.exit(2);
}

// ---------- Schema-dependent SQL (FILL IN AFTER DISCOVERY) ----------
//
// SCHEMA TODO: replace this query with one that, against the live
// RemoteManagement.sqlite on your macOS version, returns rows with the
// shape:
//
//   day_local TEXT       -- YYYY-MM-DD in $TZ
//   label     TEXT       -- bundle id or display name (e.g. "org.telegram.app")
//   category  TEXT       -- optional, "" if none
//   minutes   INTEGER    -- aggregated minutes that day
//
// Run scripts/screentime-discover.sh and paste the output back to
// Claude — that turns this placeholder into a real query.
//
// The placeholder below intentionally returns no rows, so this script
// is safe to schedule before the schema is known: it'll post empty
// payloads (which the server skips) rather than crash.

const SCREENTIME_QUERY = `
-- SCHEMA TODO — see scripts/screentime-discover.sh
SELECT
  '1970-01-01' AS day_local,
  '__placeholder__' AS label,
  ''                AS category,
  0                 AS minutes
WHERE 0 = 1;
`;

// ---------- DB copy + query ----------

type RawRow = {
  day_local: string;
  label: string;
  category: string;
  minutes: number;
};

function copyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "screentime-mac-sync-"));
  const dest = join(dir, "snapshot.sqlite");
  copyFileSync(DB_PATH, dest);
  // WAL/SHM may or may not exist depending on whether macOS has
  // checkpointed recently — copy if present so we read a consistent view.
  for (const suffix of ["-wal", "-shm"]) {
    const src = `${DB_PATH}${suffix}`;
    if (existsSync(src)) copyFileSync(src, `${dest}${suffix}`);
  }
  return dest;
}

function querySnapshot(snapshotPath: string): RawRow[] {
  // Use sqlite3 CLI in -json mode. Avoids a native dependency in the
  // launchd context (no node-sqlite3 build pain on every macOS update).
  const cmd = [
    "/usr/bin/sqlite3",
    `"${snapshotPath}"`,
    `"${SCREENTIME_QUERY.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
    "-json",
  ].join(" ");
  let stdout: string;
  try {
    stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`sqlite3 failed: ${msg}`);
    process.exit(3);
  }
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as RawRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`Failed to parse sqlite output as JSON: ${(e as Error).message}`);
    console.error("Raw output:", trimmed.slice(0, 500));
    return [];
  }
}

// ---------- Aggregation ----------

type DayPayload = {
  date: string;
  tz: string;
  source: string;
  items: { label: string; category: string; minutes: number }[];
};

function groupByDay(rows: RawRow[]): DayPayload[] {
  const cutoff = lookbackCutoff();
  const byDay = new Map<string, DayPayload>();
  for (const r of rows) {
    const date = r.day_local;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < cutoff) continue;
    const minutes = Math.max(0, Math.round(Number(r.minutes) || 0));
    if (minutes === 0) continue;
    const label = String(r.label || "").trim();
    if (!label || label === "__placeholder__") continue;
    let day = byDay.get(date);
    if (!day) {
      day = { date, tz: TZ, source: SOURCE, items: [] };
      byDay.set(date, day);
    }
    day.items.push({
      label,
      category: String(r.category || ""),
      minutes,
    });
  }
  return Array.from(byDay.values()).sort((a, b) =>
    a.date < b.date ? -1 : 1
  );
}

function lookbackCutoff(): string {
  const now = new Date();
  const cutoffMs = now.getTime() - LOOKBACK_DAYS * 86400 * 1000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(cutoffMs));
}

// ---------- POST ----------

async function postPayload(payload: DayPayload): Promise<{
  ok: boolean;
  status: number;
  body: string;
}> {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

// ---------- Main ----------

async function main() {
  const snapshot = copyDb();
  let exitCode = 0;
  try {
    const rows = querySnapshot(snapshot);
    const days = groupByDay(rows);

    if (days.length === 0) {
      console.log(
        `[screentime-mac-sync] no rows from query (lookback ${LOOKBACK_DAYS}d). If the schema TODO in this script hasn't been filled in, that's expected.`
      );
      return;
    }

    for (const day of days) {
      const result = await postPayload(day);
      if (!result.ok) {
        console.error(
          `[screentime-mac-sync] POST ${result.status} for ${day.date}: ${result.body.slice(0, 200)}`
        );
        exitCode = 4;
      } else {
        console.log(
          `[screentime-mac-sync] posted ${day.date}: ${day.items.length} apps`
        );
      }
    }
  } finally {
    try {
      rmSync(snapshot.replace(/\/snapshot\.sqlite$/, ""), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore cleanup failures */
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("[screentime-mac-sync] fatal:", (e as Error).message);
  process.exit(99);
});
