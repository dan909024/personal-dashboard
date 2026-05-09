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
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INGEST_URL = process.env.SCREENTIME_INGEST_URL || "";
const INGEST_SECRET = process.env.SCREENTIME_INGEST_SECRET || "";
const TZ = process.env.SCREENTIME_TZ || "Australia/Sydney";
const SOURCE = "mac_ui_iphone";
const SCRAPER = join(__dirname, "screentime-ui-scrape.js");

// Gating: launchd fires this job every 2 minutes. The scrape itself
// takes 3-5 minutes and steals focus while running, so we don't want
// it firing constantly. Three gates checked in order:
//
//   1. Force-trigger override — the dashboard's "Refresh iPhone
//      screen time" button writes a timestamp to a Sheet cell via
//      POST /api/screentime/trigger. We GET that timestamp at
//      startup; if it's newer than our last success AND within
//      FORCE_TRIGGER_FRESHNESS_S, we bypass idle + cooldown and
//      run immediately.
//
//   2. Cooldown — after a successful scrape, sleep for COOLDOWN_S
//      before another can fire. Default 4 h (14400 s). Override via
//      SCREENTIME_UI_COOLDOWN_S env.
//
//   3. Idle gate — only run when the user has been idle for at least
//      IDLE_THRESHOLD_S (HID-input-quiet seconds). Default 120 s.
//      Override via SCREENTIME_UI_IDLE_S env.
//
// State (cooldown anchor + last consumed force-trigger timestamp)
// is persisted to ~/.screentime-scraper/state.json so it survives
// launchd job restarts.
const IDLE_THRESHOLD_S = Number(process.env.SCREENTIME_UI_IDLE_S) || 120;
const COOLDOWN_S = Number(process.env.SCREENTIME_UI_COOLDOWN_S) || 4 * 60 * 60;
const FORCE_TRIGGER_FRESHNESS_S = 10 * 60; // 10 minutes
const STATE_DIR = join(homedir(), ".screentime-scraper");
const STATE_PATH = join(STATE_DIR, "state.json");
// GET /api/screentime/trigger is on the same host as ingest. Derive
// it from INGEST_URL (which ends in /api/screentime/ingest) so the
// launchd plist only has to set one URL.
const TRIGGER_URL = INGEST_URL.replace(/\/ingest$/, "/trigger");

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

function readIdleSeconds(): number {
  // Reads HIDIdleTime (nanoseconds since last input) from ioreg.
  // Returns elapsed seconds. Falls back to 0 on parse failure so a
  // broken read errs on the side of "not idle" — won't run at all.
  try {
    const out = execSync(
      "/usr/sbin/ioreg -c IOHIDSystem | grep HIDIdleTime",
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const match = out.match(/HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return 0;
    return Math.floor(Number(match[1]) / 1e9);
  } catch {
    return 0;
  }
}

type State = { lastSuccessAt?: string; lastConsumedForceTriggerAt?: string };
function readState(): State {
  try {
    if (!existsSync(STATE_PATH)) return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  } catch {
    return {};
  }
}
function writeState(s: State) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function readForceTrigger(): Promise<string | null> {
  if (!TRIGGER_URL) return null;
  try {
    const res = await fetch(TRIGGER_URL, {
      headers: { Authorization: `Bearer ${INGEST_SECRET}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { force_trigger_at?: string | null };
    return body.force_trigger_at ?? null;
  } catch {
    return null;
  }
}

function secondsSinceLastSuccess(state: State): number {
  if (!state.lastSuccessAt) return Infinity;
  const t = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(t)) return Infinity;
  return Math.floor((Date.now() - t) / 1000);
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[screentime-ui-sync] started ${startedAt}`);

  const state = readState();

  // Force-trigger override: if the dashboard's Refresh button has
  // been pressed since our last consumed trigger AND the timestamp
  // is fresh, bypass cooldown + idle.
  let forceTriggered = false;
  const forceTriggerAt = await readForceTrigger();
  if (forceTriggerAt) {
    const triggerAge = Math.floor((Date.now() - Date.parse(forceTriggerAt)) / 1000);
    const alreadyConsumed = state.lastConsumedForceTriggerAt === forceTriggerAt;
    if (
      Number.isFinite(triggerAge) &&
      triggerAge >= 0 &&
      triggerAge <= FORCE_TRIGGER_FRESHNESS_S &&
      !alreadyConsumed
    ) {
      forceTriggered = true;
      console.log(
        `[screentime-ui-sync] force-trigger ${forceTriggerAt} (age ${triggerAge}s) — bypassing gates`
      );
    }
  }

  if (!forceTriggered) {
    // Cooldown gate — skip silently if we successfully scraped recently.
    const sinceLast = secondsSinceLastSuccess(state);
    if (sinceLast < COOLDOWN_S) {
      console.log(
        `[screentime-ui-sync] skipping — cooldown active (last success ${sinceLast}s ago, need ${COOLDOWN_S}s)`
      );
      return;
    }

    // Idle gate — only run when the user has been quiet for at least
    // IDLE_THRESHOLD_S seconds. launchd retries every 2 minutes; we'll
    // catch the first qualifying idle window.
    const idle = readIdleSeconds();
    if (idle < IDLE_THRESHOLD_S) {
      console.log(
        `[screentime-ui-sync] skipping — user active (idle ${idle}s, need ${IDLE_THRESHOLD_S}s)`
      );
      return;
    }
  }

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

  // Mark cooldown — next scrape can't fire until COOLDOWN_S elapses.
  // Also record the force-trigger timestamp we honoured (if any) so
  // future invocations don't re-fire on the same Sheet value.
  writeState({
    lastSuccessAt: new Date().toISOString(),
    lastConsumedForceTriggerAt: forceTriggerAt || state.lastConsumedForceTriggerAt,
  });
}

main().catch((e) => {
  console.error("[screentime-ui-sync] fatal:", (e as Error).message);
  process.exit(99);
});
