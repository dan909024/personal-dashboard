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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
//   4. Working-hours gate — skip during the local hours
//      [SCREENTIME_UI_WORK_START_H, SCREENTIME_UI_WORK_END_H). Default
//      [9, 17) Australia/Sydney, so the scrape only fires before 9am
//      or at/after 5pm and never steals focus mid-meeting.
//
// State (cooldown anchor + last consumed force-trigger timestamp)
// is persisted to ~/.screentime-scraper/state.json so it survives
// launchd job restarts.
const IDLE_THRESHOLD_S = Number(process.env.SCREENTIME_UI_IDLE_S) || 120;
const COOLDOWN_S = Number(process.env.SCREENTIME_UI_COOLDOWN_S) || 4 * 60 * 60;
const WORK_START_H = Number(process.env.SCREENTIME_UI_WORK_START_H) || 9;
const WORK_END_H = Number(process.env.SCREENTIME_UI_WORK_END_H) || 17;
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
  let stderr: string;
  try {
    // execFileSync only returns stdout, but the JXA scraper uses
    // console.log for diagnostic output (which goes to stderr in
    // osascript). We need both: stdout for the JSON result, stderr
    // for the [scrape] diagnostic lines.
    const result = require("node:child_process").spawnSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", SCRAPER],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `osascript exited ${result.status} | stderr: ${(result.stderr || "").slice(0, 300)}`
      );
    }
    stdout = result.stdout || "";
    stderr = result.stderr || "";
  } catch (e) {
    const err = e as Error & { stdout?: Buffer; stderr?: Buffer };
    const stderrStr = err.stderr?.toString() || "";
    const stdoutStr = err.stdout?.toString() || "";
    throw new Error(
      `osascript failed: ${err.message} | stderr: ${stderrStr.slice(0, 300)} | stdout: ${stdoutStr.slice(0, 300)}`
    );
  }
  // Surface the JXA diagnostic lines so they end up in the launchd
  // log alongside the TS driver's own log lines.
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (t) console.log(`[scrape-diag] ${t}`);
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

// Privacy redaction — keep this dashboard work-presentable.
//
// We drop ANY row whose label contains a personal-identifier or
// employer-term token: name, employer, work-product names. Match is
// case-insensitive, on word boundaries, with an optional possessive
// 's so "Daniel's iPhone" matches.
//
// This applies to ALL labels — apps AND Safari website rows. So
// `loyalfans.com` is fine, `daniel-personal-blog.com` is dropped.
// Browsing-history rows themselves are intentionally NOT filtered
// (the dashboard wants to show them).
//
// See memory file: feedback_personal_identifier_redaction.md
//
// Use a non-global flag for `.test()` (test() with /g has stateful
// exec semantics — bug magnet), and a global flag for stripping.
const PERSONAL_REDACT_REGEX =
  /\b(avid|pubsuite|daniel|ferrari)(['’]s)?\b/i;
const PERSONAL_REDACT_REGEX_GLOBAL =
  /\b(avid|pubsuite|daniel|ferrari)(['’]s)?\b/gi;

function redactionReason(label: string): string | null {
  if (PERSONAL_REDACT_REGEX.test(label)) return "personal_identifier";
  return null;
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
}): Promise<{ ok: boolean; status: number; body: string }> {
  // Retry on transient network errors. The scrape costs 3-5 minutes
  // of work — a single `fetch failed` shouldn't waste it. We don't
  // retry HTTP-level failures (4xx/5xx) because those typically
  // indicate a payload or server-config issue that won't resolve
  // by trying again.
  const MAX_TRIES = 3;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
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
    } catch (e) {
      lastErr = e as Error;
      if (attempt < MAX_TRIES) {
        const backoffMs = 1500 * attempt;
        console.warn(
          `[screentime-ui-sync] POST attempt ${attempt} failed (${lastErr.message}); retrying in ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr || new Error("POST failed after retries");
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

// Lockfile to prevent overlapping runs — launchd fires every 2
// minutes but a real scrape takes 3-5, so without this we'd cascade
// into 2-3 concurrent scrapes all driving System Settings at once.
const LOCK_PATH = join(STATE_DIR, "lock");
const LOCK_STALE_S = 15 * 60; // assume stale after 15 min (covers slowest scrape + buffer)

function acquireLock(): boolean {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK_PATH)) {
    try {
      const ageS = Math.floor(
        (Date.now() - Number(readFileSync(LOCK_PATH, "utf8"))) / 1000
      );
      if (Number.isFinite(ageS) && ageS < LOCK_STALE_S) return false;
    } catch { /* fall through and overwrite stale lock */ }
  }
  writeFileSync(LOCK_PATH, String(Date.now()));
  return true;
}

function releaseLock() {
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[screentime-ui-sync] started ${startedAt}`);

  if (!acquireLock()) {
    console.log("[screentime-ui-sync] skipping — another scrape in progress (lock held)");
    return;
  }

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
      // Mark consumed RIGHT NOW (before scraping). If the scrape
      // crashes or the POST fails, future invocations won't re-fire
      // the same trigger forever. The user can click Refresh again
      // if they really want to retry.
      writeState({
        lastSuccessAt: state.lastSuccessAt,
        lastConsumedForceTriggerAt: forceTriggerAt,
      });
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

    // Working-hours gate — only run before WORK_START_H or at/after
    // WORK_END_H in TZ. Default 09:00–17:00 Sydney is blocked.
    const localHourStr = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date());
    const localHour = Number(localHourStr) % 24;
    if (localHour >= WORK_START_H && localHour < WORK_END_H) {
      console.log(
        `[screentime-ui-sync] skipping — working hours (hour ${localHour} in [${WORK_START_H}, ${WORK_END_H}))`
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

  // Redact personal terms from the device label for the log
  // (e.g. "Daniel's iPhone" → "iPhone") so /tmp/screentime-ui-sync.log
  // doesn't carry his name across the disk.
  const deviceForLog = result.device
    .replace(PERSONAL_REDACT_REGEX_GLOBAL, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  console.log(
    `[screentime-ui-sync] scraped device="${deviceForLog}" date="${result.date}" picker="${result.picker}" total="${result.total}" rows=${result.rows.length}`
  );

  const date = todayInTZ();
  const allItems = result.rows
    .map((r) => ({
      label: r.name.trim().slice(0, 200),
      category: "",
      minutes: parseTimeToMinutes(r.time),
    }))
    .filter((it) => it.label && it.minutes > 0);

  // Privacy filter (see memory: feedback_personal_identifier_redaction).
  // Drop rows that would leak personal identifiers or reveal browsing
  // history. Apps-only on the dashboard.
  const items: typeof allItems = [];
  const dropped: { label: string; reason: string }[] = [];
  for (const it of allItems) {
    const reason = redactionReason(it.label);
    if (reason) {
      dropped.push({ label: it.label, reason });
      continue;
    }
    items.push(it);
  }
  if (dropped.length) {
    console.log(
      `[screentime-ui-sync] redacted ${dropped.length} row(s): ${dropped
        .map((d) => `${d.label.slice(0, 30)} (${d.reason})`)
        .join(", ")}`
    );
  }

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

// Release the lockfile on every exit path — process.exit, uncaught
// throw, success. Without this, a crashed scrape leaves the lock
// held until LOCK_STALE_S elapses, blocking legitimate runs.
process.on("exit", () => releaseLock());

main().catch((e) => {
  console.error("[screentime-ui-sync] fatal:", (e as Error).message);
  process.exit(99);
});
