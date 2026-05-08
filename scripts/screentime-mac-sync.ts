/**
 * Mac Screen Time collector.
 *
 * Reads ~/Library/Application Support/Knowledge/knowledgeC.db — macOS's
 * activity store (Screen Time + app usage). Per-app per-day minutes,
 * aggregated locally in $TZ, POSTed to the dashboard's screentime
 * ingest endpoint.
 *
 * The DB is owner-readable, but launchd-spawned processes don't
 * inherit Terminal.app's TCC profile, so the launchd job needs Full
 * Disk Access granted to the leaf binary that opens the file —
 * `node` (typically /usr/local/bin/node or /opt/homebrew/bin/node).
 * Interactive runs from Terminal work without any FDA setup.
 * On older macOS the DB path may differ; override with SCREENTIME_DB_PATH.
 *
 * iOS apps surface here when "Share Across Devices" is on in both
 * iOS and macOS Screen Time settings. They typically appear under
 * their iOS bundle ids (com.burbn.instagram, ru.keepcoder.Telegram, etc.)
 * — same as Mac apps, just from a different device.
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
 *   SCREENTIME_LOOKBACK_DAYS Optional, default 3, max 30.
 *   SCREENTIME_TZ            Optional, default Australia/Sydney.
 *   SCREENTIME_DB_PATH       Optional override for the SQLite path.
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
  join(homedir(), "Library/Application Support/Knowledge/knowledgeC.db");
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
    "Enable Screen Time on this Mac (System Settings → Screen Time) and turn on 'Share Across Devices' there and on iPhone. The DB takes minutes-to-hours to populate after first enable. If your macOS version stores the data elsewhere, set SCREENTIME_DB_PATH."
  );
  process.exit(2);
}

// ---------- Query ----------
//
// knowledgeC.db schema (stable since Mojave):
//   ZOBJECT
//     ZSTREAMNAME    TEXT      -- "/app/usage" for foreground app sessions
//     ZVALUESTRING   TEXT      -- bundle id (e.g. "com.apple.Safari")
//     ZSTARTDATE     REAL      -- Cocoa epoch (seconds since 2001-01-01 UTC)
//     ZENDDATE       REAL      -- Cocoa epoch
// Convert Cocoa→Unix by adding 978307200.
//
// We expand the lookback by one day on the SQL side so "today minus 3"
// in $TZ never undershoots on a UTC-vs-local-day boundary; the JS
// groupByDay step does the precise cutoff in $TZ.

const SCREENTIME_QUERY = `
SELECT
  DATE(ZSTARTDATE + 978307200, 'unixepoch', 'localtime') AS day_local,
  ZVALUESTRING AS label,
  '' AS category,
  CAST(SUM(ZENDDATE - ZSTARTDATE) / 60.0 AS INTEGER) AS minutes
FROM ZOBJECT
WHERE ZSTREAMNAME = '/app/usage'
  AND ZVALUESTRING IS NOT NULL
  AND ZVALUESTRING != ''
  -- Bundle ids only: must contain a dot, must not contain spaces. This
  -- drops macOS Screen Time category-aggregate residue (e.g. "Dating
  -- Apps", or a bare "Instagram" with no qualifier) that knowledgeC.db
  -- accumulates from stale cross-device sync. Real bundle ids look
  -- like "com.burbn.instagram" or "com.apple.Safari".
  AND ZVALUESTRING LIKE '%.%'
  AND instr(ZVALUESTRING, ' ') = 0
  AND ZSTARTDATE >= (strftime('%s', 'now', '-${LOOKBACK_DAYS + 1} days') - 978307200)
GROUP BY day_local, label
HAVING minutes > 0
ORDER BY day_local DESC, minutes DESC;
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
    if (!label) continue;
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
        `[screentime-mac-sync] no rows in lookback ${LOOKBACK_DAYS}d. Either Screen Time hasn't run yet, or the DB hasn't checkpointed since the last run.`
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
