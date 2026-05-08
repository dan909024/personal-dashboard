/**
 * Self-contained weekly dry-run of the rules evaluator. Aggregates
 * daily rule outcomes across a Mon-Sun ISO week, prints per-rule
 * weekly fines and the total. No Sheet writes.
 *
 * Usage:
 *   npx tsx scripts/rules-dry-run.ts                # prior completed week (default)
 *   npx tsx scripts/rules-dry-run.ts current         # current week (in-progress estimate)
 *   npx tsx scripts/rules-dry-run.ts 2026-W18        # specific ISO week
 *   npx tsx scripts/rules-dry-run.ts 2026-05-04      # any date in the target week
 *
 * Flip Active=yes in the Sheet for any rule you want evaluated first.
 *
 * Note: requires GOOGLE_SERVICE_ACCOUNT_JSON + SHEET_ID in .env.local
 * (Vercel CLI v1 quoted format OR v2 unquoted format both supported).
 */
import { readFileSync } from "node:fs";
import { google, sheets_v4 } from "googleapis";

function loadDotEnvLocal(path = ".env.local"): void {
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    let m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
    if (!m) m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    process.env[m[1]] = m[2];
  }
}
loadDotEnvLocal();

function decodeVercelEnvJson(raw: string): string {
  if (raw.startsWith("{")) return raw;
  if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
  let out = ""; let i = 0; let inString = false; let escapeNext = false;
  while (i < raw.length) {
    const c = raw[i];
    if (inString) {
      if (escapeNext) { out += c; escapeNext = false; i++; continue; }
      if (c === "\\") { out += c; escapeNext = true; i++; continue; }
      if (c === '"') { inString = false; out += c; i++; continue; }
      if (c === "\n") { out += "\\n"; i++; continue; }
      if (c === "\r") { out += "\\r"; i++; continue; }
      if (c === "\t") { out += "\\t"; i++; continue; }
      out += c; i++; continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === "n") { out += "\n"; i += 2; continue; }
      if (n === "r") { out += "\r"; i += 2; continue; }
      if (n === "t") { out += "\t"; i += 2; continue; }
    }
    out += c; i++;
  }
  return out;
}

// ---------- Date / ISO week helpers ----------

function sydneyTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(date + "T12:00:00Z") + days * 86400 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isoWeekContaining(date: string): { monday: string; sunday: string; year: number; week: number } {
  const t = Date.parse(date + "T12:00:00Z");
  const d = new Date(t);
  const day = d.getUTCDay() || 7; // Sun=0 → 7
  const monday = new Date(t - (day - 1) * 86400 * 1000).toISOString().slice(0, 10);
  const sunday = new Date(t + (7 - day) * 86400 * 1000).toISOString().slice(0, 10);

  // ISO week number — anchor on the Thursday of the week
  const thursday = new Date(t + (4 - day) * 86400 * 1000);
  const yr = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(yr, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400 * 1000);
  const weeksDiff = Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 86400 * 1000));
  const week = weeksDiff + 1;
  return { monday, sunday, year: yr, week };
}

function priorIsoWeek(): { monday: string; sunday: string; year: number; week: number } {
  const today = sydneyTodayISO();
  const thisWeek = isoWeekContaining(today);
  const lastSunday = addDays(thisWeek.monday, -1);
  return isoWeekContaining(lastSunday);
}

function parseTargetArg(arg: string | undefined): { monday: string; sunday: string; year: number; week: number; partial: boolean } {
  if (!arg) {
    const w = priorIsoWeek();
    return { ...w, partial: false };
  }
  if (arg === "current") {
    const w = isoWeekContaining(sydneyTodayISO());
    return { ...w, partial: true };
  }
  const isoMatch = arg.match(/^(\d{4})-W(\d{1,2})$/);
  if (isoMatch) {
    // Find the Monday of ISO year/week
    const yr = Number(isoMatch[1]);
    const wk = Number(isoMatch[2]);
    const jan4 = new Date(Date.UTC(yr, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400 * 1000);
    const monday = new Date(week1Monday.getTime() + (wk - 1) * 7 * 86400 * 1000)
      .toISOString().slice(0, 10);
    return { ...isoWeekContaining(monday), partial: false };
  }
  const dateMatch = arg.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return { ...isoWeekContaining(arg), partial: false };
  }
  throw new Error(`Unrecognized argument: ${arg}`);
}

function clockToMin(raw: string): number | null {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]); const mn = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mn)) return null;
  return h * 60 + mn;
}

function bedToMin(raw: string): number | null {
  const min = clockToMin(raw);
  if (min === null) return null;
  if (min < 6 * 60) return min + 24 * 60;
  return min;
}

function normalizeDate(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    const ms = (raw - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// ---------- Sheet readers ----------

async function makeClient(): Promise<sheets_v4.Sheets> {
  const credsRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!credsRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing in .env.local");
  const creds = JSON.parse(decodeVercelEnvJson(credsRaw));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

type Row = (string | number)[];
async function read(client: sheets_v4.Sheets, range: string): Promise<Row[]> {
  try {
    const res = await client.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID!,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    return (res.data.values || []) as Row[];
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
    throw e;
  }
}

// ---------- Types ----------

type RuleCheckRow = {
  id: string; active: boolean; description: string; threshold: string;
  fine: number; meterDeltaPass: number; meterDeltaFail: number; notes: string;
};
type WhoopDaily = { date: string; recovery: string; wakeTime: string; bedTime: string };
type WhoopWorkout = { date: string; sportId: number | null; strain: number | null };
type ScreentimeRow = { date: string; source: string; label: string; minutes: number; syncedAt: string };
type AppleHealthRow = { date: string; steps: number };

const APP_DISPLAY_NAMES: Record<string, string> = {
  "com.burbn.instagram": "Instagram",
  "com.cardify.tinder": "Tinder", "co.match.tinder": "Tinder",
  "com.hinge.app": "Hinge", "com.bumble.app": "Bumble",
  "com.google.ios.youtube": "YouTube", "com.zhiliaoapp.musically": "TikTok",
};
function displayAppName(label: string): string { return APP_DISPLAY_NAMES[label] ?? label; }
const SCREENTIME_SUSPICIOUS_THRESHOLD = 18 * 60;

const IG = new Set(["com.burbn.instagram", "Instagram"]);
const YT = new Set(["com.google.ios.youtube", "YouTube"]);
const DATING = new Set([
  "com.cardify.tinder", "co.match.tinder", "com.hinge.app", "com.bumble.app",
  "Tinder", "Hinge", "Bumble",
]);

function sumScreentime(s: ScreentimeRow[], match: Set<string>): number {
  return s
    .filter((r) => match.has(r.label) || match.has(displayAppName(r.label)))
    .filter((r) => r.minutes < SCREENTIME_SUSPICIOUS_THRESHOLD)
    .reduce((acc, r) => acc + r.minutes, 0);
}

// ---------- Weekly evaluator ----------

type WeeklyOutcome = {
  ruleId: string;
  fineAmount: number;
  summary: string; // e.g. "4 late wakes · 92m total"
  reasonText: string; // for Punishments row dedupe
};

function evalWeek(
  rules: RuleCheckRow[],
  weekId: string, // "2026-W18"
  daysInWindow: string[], // [YYYY-MM-DD ...] up to today (partial weeks shrink)
  whoopByDate: Map<string, WhoopDaily>,
  workoutsAll: WhoopWorkout[],
  appleHealthByDate: Map<string, number>,
  screentimeByDate: Map<string, ScreentimeRow[]>
): WeeklyOutcome[] {
  const out: WeeklyOutcome[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    const result = evalRuleWeek(rule, weekId, daysInWindow, whoopByDate, workoutsAll, appleHealthByDate, screentimeByDate);
    if (result) out.push(result);
  }
  return out;
}

function evalRuleWeek(
  rule: RuleCheckRow,
  weekId: string,
  days: string[],
  whoopByDate: Map<string, WhoopDaily>,
  workoutsAll: WhoopWorkout[],
  appleHealthByDate: Map<string, number>,
  screentimeByDate: Map<string, ScreentimeRow[]>
): WeeklyOutcome | null {
  switch (rule.id) {
    case "wake_late": {
      const t = clockToMin(rule.threshold);
      if (t === null) return null;
      let lateDays = 0; let totalMinLate = 0;
      for (const d of days) {
        const w = clockToMin(whoopByDate.get(d)?.wakeTime ?? "");
        if (w === null || w <= t) continue;
        lateDays++; totalMinLate += w - t;
      }
      if (lateDays === 0) return passO(rule.id, weekId, rule.description, "no late wakes");
      const blocks = Math.ceil(totalMinLate / 15);
      return failO(rule.id, weekId, rule.description, rule.fine * blocks,
        `${lateDays} late wake${lateDays === 1 ? "" : "s"} · ${totalMinLate}m total = ${blocks}×$${rule.fine}`);
    }
    case "bed_late": {
      const t = clockToMin(rule.threshold);
      if (t === null) return null;
      let count = 0;
      for (const d of days) {
        const b = bedToMin(whoopByDate.get(d)?.bedTime ?? "");
        if (b === null || b <= t) continue;
        count++;
      }
      if (count === 0) return passO(rule.id, weekId, rule.description, "no late beds");
      return failO(rule.id, weekId, rule.description, rule.fine * count,
        `${count} late bed${count === 1 ? "" : "s"} = ${count}×$${rule.fine}`);
    }
    case "steps_short": {
      const target = Number(rule.threshold) || 0;
      const totalSteps = days.reduce((sum, d) => sum + (appleHealthByDate.get(d) ?? 0), 0);
      if (totalSteps >= target) {
        return passO(rule.id, weekId, rule.description, `${totalSteps.toLocaleString("en-AU")} steps`);
      }
      const shortfall = target - totalSteps;
      const blocks = Math.ceil(shortfall / 10000);
      return failO(rule.id, weekId, rule.description, rule.fine * blocks,
        `${totalSteps.toLocaleString("en-AU")}/${target.toLocaleString("en-AU")} steps · ${shortfall.toLocaleString("en-AU")} short = ${blocks}×$${rule.fine}`);
    }
    case "gym_skipped": {
      const target = Number(rule.threshold) || 0;
      const count = workoutsAll.filter((w) => days.includes(w.date)).length;
      if (count >= target) return passO(rule.id, weekId, rule.description, `${count} workouts`);
      return failO(rule.id, weekId, rule.description, rule.fine,
        `${count}/${target} workouts logged`);
    }
    case "strain_low": {
      const t = Number(rule.threshold) || 0;
      let lowDays = 0;
      for (const d of days) {
        const wk = workoutsAll.filter((w) => w.date === d);
        if (wk.length === 0) continue; // skipped (no workout)
        const max = wk.reduce((m, w) => (w.strain !== null && w.strain > m ? w.strain : m), 0);
        if (max < t) lowDays++;
      }
      if (lowDays === 0) return passO(rule.id, weekId, rule.description, "all workout days hit strain target");
      return failO(rule.id, weekId, rule.description, rule.fine * lowDays,
        `${lowDays} workout day${lowDays === 1 ? "" : "s"} below strain ${t} = ${lowDays}×$${rule.fine}`);
    }
    case "ig_over":
      return evalScreenWeek(rule, weekId, days, screentimeByDate, IG, "Instagram");
    case "yt_over":
      return evalScreenWeek(rule, weekId, days, screentimeByDate, YT, "YouTube");
    case "dating_app_used": {
      let dirtyDays = 0;
      for (const d of days) {
        const minutes = sumScreentime(screentimeByDate.get(d) ?? [], DATING);
        if (minutes > 0) dirtyDays++;
      }
      if (dirtyDays === 0) return passO(rule.id, weekId, rule.description, "no dating app usage");
      return failO(rule.id, weekId, rule.description, rule.fine * dirtyDays,
        `${dirtyDays} day${dirtyDays === 1 ? "" : "s"} on dating apps = ${dirtyDays}×$${rule.fine}`);
    }
    case "whoop_no_data": {
      let missingDays = 0;
      for (const d of days) {
        const wd = whoopByDate.get(d);
        if (!wd || (!wd.wakeTime && !wd.recovery)) missingDays++;
      }
      if (missingDays === 0) return passO(rule.id, weekId, rule.description, "Whoop synced every day");
      return failO(rule.id, weekId, rule.description, rule.fine * missingDays,
        `${missingDays} missing day${missingDays === 1 ? "" : "s"} = ${missingDays}×$${rule.fine}`);
    }
    default:
      return null;
  }
}

function evalScreenWeek(
  rule: RuleCheckRow,
  weekId: string,
  days: string[],
  byDate: Map<string, ScreentimeRow[]>,
  match: Set<string>,
  appName: string
): WeeklyOutcome {
  const t = Number(rule.threshold) || 0;
  let overBlocks = 0;
  let overDays = 0;
  let totalOverMin = 0;
  for (const d of days) {
    const minutes = sumScreentime(byDate.get(d) ?? [], match);
    if (minutes <= t) continue;
    const over = minutes - t;
    overBlocks += Math.ceil(over / 5);
    overDays++;
    totalOverMin += over;
  }
  if (overBlocks === 0) return passO(rule.id, weekId, rule.description, `${appName} within limit all week`);
  return failO(rule.id, weekId, rule.description, rule.fine * overBlocks,
    `${appName} over ${overDays} day${overDays === 1 ? "" : "s"} · ${totalOverMin}m over = ${overBlocks}×$${rule.fine}`);
}

function passO(ruleId: string, weekId: string, desc: string, summary: string): WeeklyOutcome {
  return { ruleId, fineAmount: 0, summary,
    reasonText: `[rule:${ruleId}] ${desc} (${weekId})` };
}
function failO(ruleId: string, weekId: string, desc: string, fineAmount: number, summary: string): WeeklyOutcome {
  return { ruleId, fineAmount, summary,
    reasonText: `[rule:${ruleId}] ${summary} (${weekId})` };
}

// ---------- Main ----------

async function main() {
  const arg = process.argv[2];
  const target = parseTargetArg(arg);
  const weekId = `${target.year}-W${String(target.week).padStart(2, "0")}`;
  const today = sydneyTodayISO();

  // For partial (current) week, only sum days up to today (inclusive).
  const allDays: string[] = [];
  for (let i = 0; i < 7; i++) {
    allDays.push(addDays(target.monday, i));
  }
  const days = target.partial ? allDays.filter((d) => d <= today) : allDays;

  console.log(`Dry-run for week ${weekId} (${target.monday}…${target.sunday})${target.partial ? " — IN PROGRESS" : ""}`);
  console.log(`Evaluating ${days.length} day${days.length === 1 ? "" : "s"}: ${days.join(", ")}\n`);

  const client = await makeClient();
  const [rcRows, wdRows, wwRows, ahRows, stRows] = await Promise.all([
    read(client, "Rule Checks!A1:H"),
    read(client, "Whoop Daily!A1:H"),
    read(client, "Whoop Workouts!A1:K"),
    read(client, "Apple Health!A1:G"),
    read(client, "Screen Time!A1:F"),
  ]);

  const rules: RuleCheckRow[] = rcRows.slice(1).filter((r) => r && r[0]).map((r) => ({
    id: String(r[0]).trim(),
    active: String(r[1] ?? "").trim().toLowerCase() === "yes",
    description: String(r[2] ?? "").trim(),
    threshold: String(r[3] ?? "").trim(),
    fine: Number(r[4] ?? 0) || 0,
    meterDeltaPass: Number(r[5] ?? 0) || 0,
    meterDeltaFail: Number(r[6] ?? 0) || 0,
    notes: String(r[7] ?? "").trim(),
  }));
  const active = rules.filter((r) => r.active);
  console.log(`Rules: ${active.length}/${rules.length} active`);
  if (active.length === 0) {
    console.log("Nothing to evaluate. Flip Active=yes in the Sheet for rules you want armed.");
    return;
  }

  // Whoop Daily (by date)
  const whoopByDate = new Map<string, WhoopDaily>();
  for (let i = 1; i < wdRows.length; i++) {
    const r = wdRows[i]; if (!r) continue;
    const d = normalizeDate(r[0]); if (!d || !days.includes(d)) continue;
    whoopByDate.set(d, {
      date: d, recovery: String(r[1] ?? ""),
      wakeTime: String(r[4] ?? ""), bedTime: String(r[5] ?? ""),
    });
  }

  // Whoop Workouts (filter to week)
  const workoutsAll: WhoopWorkout[] = [];
  for (let i = 1; i < wwRows.length; i++) {
    const r = wwRows[i]; if (!r) continue;
    const d = normalizeDate(r[0]); if (!d || !days.includes(d)) continue;
    workoutsAll.push({
      date: d,
      sportId: r[2] === "" || r[2] === undefined || r[2] === null ? null : Number(r[2]),
      strain: r[3] === "" || r[3] === undefined || r[3] === null ? null : Number(r[3]),
    });
  }

  // Apple Health (by date)
  const appleHealthByDate = new Map<string, number>();
  for (let i = 1; i < ahRows.length; i++) {
    const r = ahRows[i]; if (!r) continue;
    const d = normalizeDate(r[0]); if (!d || !days.includes(d)) continue;
    const steps = Number(r[1] ?? 0) || 0;
    // Multiple sources possible per day; keep the max (Apple Health per-source is independent).
    const existing = appleHealthByDate.get(d) ?? 0;
    if (steps > existing) appleHealthByDate.set(d, steps);
  }

  // Screen Time (by date) — drop categories, dedupe by source/label, prefer mac
  const screentimeByDate = new Map<string, ScreentimeRow[]>();
  for (const d of days) {
    const stage1 = new Map<string, ScreentimeRow>();
    for (let i = 1; i < stRows.length; i++) {
      const r = stRows[i]; if (!r) continue;
      const rd = normalizeDate(r[0]); if (rd !== d) continue;
      const source = String(r[1] ?? ""); const label = String(r[2] ?? "");
      const category = String(r[3] ?? ""); if (category === "category") continue;
      const minutes = Number(r[4] ?? 0) || 0;
      const syncedAt = String(r[5] ?? "");
      const key = `${rd}|${source}|${label}`;
      const existing = stage1.get(key);
      if (!existing || syncedAt > existing.syncedAt) {
        stage1.set(key, { date: rd, source, label, minutes, syncedAt });
      }
    }
    const stage2 = new Map<string, ScreentimeRow>();
    for (const row of stage1.values()) {
      const key = `${row.date}|${displayAppName(row.label)}`;
      const ex = stage2.get(key);
      if (!ex) { stage2.set(key, row); continue; }
      const exIsMac = ex.source === "mac_launchd";
      const newIsMac = row.source === "mac_launchd";
      if (newIsMac && !exIsMac) stage2.set(key, row);
    }
    screentimeByDate.set(d, Array.from(stage2.values()));
  }

  // Inputs summary
  const totalSteps = days.reduce((s, d) => s + (appleHealthByDate.get(d) ?? 0), 0);
  const whoopDays = Array.from(whoopByDate.keys()).length;
  console.log(
    `Inputs: ${whoopDays}/${days.length} Whoop days · ${workoutsAll.length} workouts · ` +
      `${totalSteps.toLocaleString("en-AU")} total steps\n`
  );

  const outcomes = evalWeek(active, weekId, days, whoopByDate, workoutsAll, appleHealthByDate, screentimeByDate);
  let totalFines = 0;
  for (const o of outcomes) {
    const tag = o.fineAmount > 0 ? "  ✗ FAIL" : "  ✓ PASS";
    const fine = o.fineAmount > 0 ? `  $${o.fineAmount}` : "";
    console.log(`${tag} ${o.ruleId.padEnd(18)} ${o.summary}${fine}`);
    totalFines += o.fineAmount;
  }
  console.log(`\n${target.partial ? "Running estimate" : "Total fines for week"}: $${totalFines}`);
  if (totalFines > 0 && !target.partial) {
    console.log("\nWould append the following to Punishments:");
    for (const o of outcomes) {
      if (o.fineAmount > 0) console.log(`  $${o.fineAmount} · ${o.reasonText}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
