/**
 * iPhone Screen Time UI sync.
 *
 * Drives scripts/screentime-ui-scrape.js (an osascript JXA helper) to
 * read the iPhone's screen time off the macOS System Settings → Screen
 * Time → App & Website Activity pane (Device popup → iPhone), then
 * POSTs the day's totals to /api/screentime/ingest.
 *
 * Companion to screentime-mac-sync.ts: that script reads knowledgeC.db
 * for Mac data; this one fills in iPhone data, which doesn't reliably
 * appear in knowledgeC.db even with "Share Across Devices" on.
 *
 * Designed to run from launchd daily at 21:00 (see
 * com.danielferrari.screentime-ui-sync.plist) and capture today's
 * cumulative iPhone usage. Also runnable on demand:
 *
 *   SCREENTIME_INGEST_URL=https://<your-vercel>/api/screentime/ingest \
 *   SCREENTIME_INGEST_SECRET=... \
 *   npx tsx scripts/screentime-ui-sync.ts
 *
 * Side effects: opens System Settings, briefly steals window focus
 * (~10–15 seconds end to end). Quits System Settings on completion.
 *
 * Permissions:
 *   - Accessibility on the binary that launches osascript
 *     (Terminal for interactive runs, /usr/bin/osascript for the
 *     launchd job — the leaf binary that actually opens the AX
 *     connection).
 *   - "Share Across Devices" enabled in Screen Time on both Mac
 *     and iPhone, otherwise the device popup won't have an iPhone
 *     entry.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const INGEST_URL = process.env.SCREENTIME_INGEST_URL || "";
const INGEST_SECRET = process.env.SCREENTIME_INGEST_SECRET || "";
const TZ = process.env.SCREENTIME_TZ || "Australia/Sydney";
const SOURCE = "mac_ui_iphone";
const SCRAPER = join(__dirname, "screentime-ui-scrape.js");

if (!INGEST_URL || !INGEST_SECRET) {
  console.error(
    "Missing SCREENTIME_INGEST_URL or SCREENTIME_INGEST_SECRET. Set them in the launchd plist (or your shell) before running."
  );
  process.exit(1);
}
if (!existsSync(SCRAPER)) {
  console.error(`scraper not found: ${SCRAPER}`);
  process.exit(2);
}

type ScrapeResult =
  | {
      ok: true;
      device: string;
      date: string;
      picker: string;
      total: string;
      windowTitle: string;
      rows: { name: string; time: string }[];
    }
  | { ok: false; error: string; stage?: string; stack?: string | null };

function runScraper(): ScrapeResult {
  let stdout: string;
  try {
    stdout = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", SCRAPER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The scraper polls the System Settings activity table for ~3-5
      // minutes to materialise as many SwiftUI lazy rows as possible.
      // Allow generous headroom; launchd's job lifecycle is fine with
      // a long-running osascript.
      timeout: 600_000,
      // Default maxBuffer (1MB) is fine — the JSON payload is ~5KB.
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as Error & { stdout?: Buffer; stderr?: Buffer };
    const stderrStr = err.stderr?.toString() || "";
    const stdoutStr = err.stdout?.toString() || "";
    throw new Error(
      `osascript failed: ${err.message} | stderr: ${stderrStr.slice(0, 300)} | stdout: ${stdoutStr.slice(0, 300)}`
    );
  }
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("scraper produced empty output");
  try {
    return JSON.parse(trimmed) as ScrapeResult;
  } catch (e) {
    throw new Error(
      `scraper JSON parse failed: ${(e as Error).message} | output: ${trimmed.slice(0, 500)}`
    );
  }
}

// "4 hours, 24 minutes" / "1 hour, 9 minutes" / "59 minutes" / "2 hours" → minutes int.
// Returns 0 if unparseable, so an unrecognisable row is dropped rather than corrupting totals.
function parseTimeToMinutes(s: string): number {
  if (!s) return 0;
  const cleaned = s.toLowerCase().replace(/\s+/g, " ").trim();
  const hourMatch = cleaned.match(/(\d+)\s*hour/);
  const minMatch = cleaned.match(/(\d+)\s*minute/);
  const secMatch = cleaned.match(/(\d+)\s*second/);
  const hours = hourMatch ? Number(hourMatch[1]) : 0;
  const minutes = minMatch ? Number(minMatch[1]) : 0;
  const seconds = secMatch ? Number(secMatch[1]) : 0;
  return hours * 60 + minutes + Math.round(seconds / 60);
}

function todayInTZ(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function postPayload(payload: {
  date: string;
  tz: string;
  source: string;
  items: { label: string; category: string; minutes: number }[];
}) {
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

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[screentime-ui-sync] started ${startedAt}`);

  const result = runScraper();
  if (!result.ok) {
    console.error(
      `[screentime-ui-sync] scraper failed at ${result.stage || "?"}: ${result.error}`
    );
    process.exit(3);
  }

  console.log(
    `[screentime-ui-sync] scraped device="${result.device}" date="${result.date}" picker="${result.picker}" total="${result.total}" rows=${result.rows.length}`
  );

  const date = todayInTZ();
  const items = result.rows
    .map((r) => ({
      label: r.name.trim().slice(0, 200),
      category: "",
      minutes: parseTimeToMinutes(r.time),
    }))
    .filter((it) => it.label && it.minutes > 0);

  if (items.length === 0) {
    console.log("[screentime-ui-sync] no rows with parseable time — nothing to post");
    return;
  }

  const payload = { date, tz: TZ, source: SOURCE, items };
  const post = await postPayload(payload);
  if (!post.ok) {
    console.error(
      `[screentime-ui-sync] POST ${post.status}: ${post.body.slice(0, 300)}`
    );
    process.exit(4);
  }
  console.log(
    `[screentime-ui-sync] posted ${date}: ${items.length} apps, total ${items.reduce((a, b) => a + b.minutes, 0)} min`
  );
}

main().catch((e) => {
  console.error("[screentime-ui-sync] fatal:", (e as Error).message);
  process.exit(99);
});
