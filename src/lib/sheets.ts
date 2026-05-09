/**
 * Google Sheets reader for the personal dashboard.
 *
 * Auth: service account JSON in GOOGLE_SERVICE_ACCOUNT_JSON env var (single line).
 * Sheet: SHEET_ID env var.
 *
 * All public functions are wrapped in unstable_cache with a 30s TTL.
 * If env vars are missing, isConfigured() returns false and reader functions
 * return empty/null so the dashboard can degrade gracefully.
 */
import { google, sheets_v4 } from "googleapis";
import { unstable_cache } from "next/cache";

// ---------- Config ----------

// Read env at call-time, not module-load time. This matters for the init
// script which loads dotenv after this module would otherwise be imported.
function sheetId(): string {
  return process.env.SHEET_ID || "";
}
function serviceAccountJsonRaw(): string {
  return process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
}

export function isConfigured(): boolean {
  return Boolean(sheetId() && serviceAccountJsonRaw());
}

// Tab schemas — keep in sync with the schema we create in ensureTabs().
export const TAB_SCHEMAS = {
  Tasks: ["Date", "Task", "Set by", "Done?", "Completed at", "Proof link"],
  Punishments: ["Date", "Amount", "Reason", "Set by", "Paid?", "Rule"],
  "Daily Log": [
    "Date",
    "Voice notes",
    "Text notes",
    "Wake time",
    "Bed time",
    "Notes",
    "Harley Meter",
  ],
  "Coach Notes": ["Date", "From", "Note"],
  "Whoop Daily": [
    "Date",
    "Recovery",
    "Strain",
    "Sleep",
    "Wake time",
    "Bed time",
    "RHR",
    "HRV",
  ],
  "Whoop Tokens": ["access_token", "refresh_token", "expires_at", "updated_at"],
  "System Health": [
    "Timestamp",
    "Heartbeat OK",
    "Whoop OK",
    "Last Whoop sync",
    "Recent sleep edits",
    "Notes",
  ],
  "Sleep Edits": [
    "Detected at",
    "Sleep ID",
    "Field changed",
    "Old value",
    "New value",
    "Source",
  ],
  "Amex Transactions": [
    "Date",
    "Type",
    "Merchant",
    "Amount",
    "Currency",
    "Card Last 4",
    "Email ID",
    "Subject",
    "Synced at",
  ],
  "Apple Health": [
    "Date",
    "Steps",
    "Workouts JSON",
    "Active Calories",
    "Resting Calories",
    "Source",
    "Synced at",
    "Water (ml)",
    "Protein (g)",
    "Calories Consumed",
  ],
  "Whoop Workouts": [
    "Date",
    "Workout ID",
    "Sport ID",
    "Strain",
    "Duration min",
    "Avg HR",
    "Max HR",
    "Kilojoules",
    "Start",
    "End",
    "Synced at",
  ],
  "Screen Time": [
    "Date",
    "Source",
    "Label",
    "Category",
    "Minutes",
    "Synced at",
  ],
  "Orgasm Log": ["Date", "Time", "Type", "Note", "Days since previous"],
  "Edge Log": ["Date", "Time", "Note"],
  "Daily Check-in": ["Date", "Arousal (1-10)", "Note"],
  "Worship Log": ["Date", "Time", "Activity", "Minutes", "Note"],
  "Self-Help Log": ["Date", "Time", "Activity", "Minutes", "Note"],
  Settings: ["Setting", "Value", "Last Updated", "Updated By"],
  Denial: ["Key", "Value"],
  "Magic Links": ["Token", "Created at", "Expires at", "Used at", "IP", "Note"],
  "Magic Link Audit": ["Timestamp", "IP", "Action", "Detail"],
  "Sync Triggers": ["Timestamp", "IP", "Whoop", "Manual asks", "Email sent", "Source"],
  "Harley Payments": [
    "Date",
    "Amount",
    "Currency",
    "Network",
    "To Address",
    "Email ID",
    "Subject",
    "Synced at",
  ],
  "Calendar Events": [
    "Event ID",
    "Etag",
    "Summary",
    "Start ISO",
    "First seen at",
    "Notified at",
  ],
  "Goddess Audit": ["Timestamp", "Action", "Detail"],
} as const;

export type TabName = keyof typeof TAB_SCHEMAS;

// ---------- Auth ----------

let cachedClient: sheets_v4.Sheets | null = null;


/**
 * Decode the Vercel-CLI .env.local format. The CLI writes JSON values
 * by wrapping in double quotes and converting literal newlines/tabs in
 * the source to "\\n" / "\\t" 2-char sequences — but does NOT escape
 * inner double quotes or doubly-escape backslashes inside string
 * literals. The result isn't valid JSON because backslash outside
 * strings is illegal in JSON. This walks the value char-by-char,
 * tracking whether we are inside a string literal, and only converts
 * escape sequences that occur OUTSIDE strings. Inside strings, the
 * 2-char "\\n" / "\\t" sequences are already valid JSON escapes.
 */
function decodeVercelEnvJson(raw: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escapeNext = false;
  while (i < raw.length) {
    const c = raw[i];
    if (inString) {
      if (escapeNext) {
        out += c;
        escapeNext = false;
        i++;
        continue;
      }
      if (c === "\\") {
        out += c;
        escapeNext = true;
        i++;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += c;
        i++;
        continue;
      }
      // Case B: literal control chars inside a string literal must
      // become their JSON escapes; otherwise JSON.parse rejects.
      if (c === "\n") { out += "\\n"; i++; continue; }
      if (c === "\r") { out += "\\r"; i++; continue; }
      if (c === "\t") { out += "\\t"; i++; continue; }
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === "n") { out += "\n"; i += 2; continue; }
      if (n === "r") { out += "\r"; i += 2; continue; }
      if (n === "t") { out += "\t"; i += 2; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Parse GOOGLE_SERVICE_ACCOUNT_JSON, tolerating the escaped form Vercel
 * CLI writes to .env.local. Exported so other Google API modules
 * (calendar, drive) can reuse the same fallback.
 */
export function loadServiceAccountCreds(): Record<string, unknown> {
  const raw = serviceAccountJsonRaw();
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON not set."
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    const decoded = decodeVercelEnvJson(raw);
    try {
      return JSON.parse(decoded);
    } catch (e2) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${(e2 as Error).message}`
      );
    }
  }
}

function sheetsClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  if (!isConfigured()) {
    throw new Error(
      "Google Sheets not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID."
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials: loadServiceAccountCreds(),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

// ---------- Helpers ----------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function todaySydneyISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function mondayOfThisWeek(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day; // back to Monday
  const monday = new Date(d.getTime() + diff * 24 * 3600 * 1000);
  return monday.toISOString().slice(0, 10);
}

/**
 * Normalize whatever the Sheet stores in a Date column to YYYY-MM-DD.
 * Accepts: ISO strings, "5/3/2026", "3/5/2026" (US), Date numbers, etc.
 */
function normalizeDate(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    // Google Sheets serial date (days since 1899-12-30)
    const ms = (raw - 25569) * 86400 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // m/d/yyyy or d/m/yyyy — assume m/d/yyyy (US default in Sheets)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Last resort
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === "yes" || s === "y" || s === "true" || s === "1" || s === "✓" || s === "x";
}

/**
 * Read all rows from a tab. Returns rows AS-IS (header row included as rows[0]).
 * Returns null if the tab does not exist (caller can fall back).
 */
async function readTab(
  tab: TabName
): Promise<string[][] | null> {
  if (!isConfigured()) return null;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: `${tab}!A1:Z`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    return (res.data.values as string[][]) || [];
  } catch (e) {
    const msg = (e as Error).message || "";
    // Missing tab → return null so the caller can show "no data yet"
    if (msg.includes("Unable to parse range") || msg.includes("not found")) {
      return null;
    }
    console.error(`[sheets] error reading tab ${tab}:`, msg);
    return null;
  }
}

// ---------- Public types ----------

export type Task = {
  date: string;
  task: string;
  setBy: string;
  done: boolean;
  completedAt: string;
  proofLink: string;
};

export type Punishment = {
  date: string;
  amount: number;
  reason: string;
  setBy: string;
  paid: boolean;
  /** HarleyRuleId from harley-rules.ts when the fine was auto-derived from a
   *  rule violation. Empty/undefined for manual fines (sheet edits, /fine
   *  Telegram command, monthly fee). */
  ruleId?: string;
};

export type CoachNote = {
  date: string;
  from: string;
  note: string;
};

export type WhoopDaily = {
  date: string;
  recovery: string;
  strain: string;
  sleep: string;
  wakeTime: string;
  bedTime: string;
  rhr: string;
  hrv: string;
};

export type DailyLog = {
  date: string;
  voiceNotes: string;
  textNotes: string;
  wakeTime: string;
  bedTime: string;
  notes: string;
  harleyMeter: string;
};

// ---------- Public readers (cached 30s) ----------

export const getTasks = unstable_cache(
  async (): Promise<Task[]> => {
    const rows = await readTab("Tasks");
    if (!rows || rows.length < 2) return [];
    const today = todayISO();
    const tasks: Task[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0]);
      if (!date) continue;
      tasks.push({
        date,
        task: r[1] || "",
        setBy: r[2] || "",
        done: isTruthy(r[3]),
        completedAt: r[4] || "",
        proofLink: r[5] || "",
      });
    }
    // Today's tasks first, then upcoming by date asc, but most recent first
    return tasks.filter((t) => t.date === today);
  },
  ["dashboard:tasks:today"],
  { revalidate: 30 }
);

export const getOpenTasks = unstable_cache(
  async (limit = 3): Promise<Task[]> => {
    const rows = await readTab("Tasks");
    if (!rows || rows.length < 2) return [];
    const tasks: Task[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0]);
      if (!date) continue;
      const t: Task = {
        date,
        task: r[1] || "",
        setBy: r[2] || "",
        done: isTruthy(r[3]),
        completedAt: r[4] || "",
        proofLink: r[5] || "",
      };
      if (!t.done && t.task) tasks.push(t);
    }
    // Most recent first, capped
    tasks.sort((a, b) => (a.date < b.date ? 1 : -1));
    return tasks.slice(0, limit);
  },
  ["dashboard:tasks:open"],
  { revalidate: 30 }
);

export const getPunishments = unstable_cache(
  async (weekStart?: string): Promise<Punishment[]> => {
    const rows = await readTab("Punishments");
    if (!rows || rows.length < 2) return [];
    const start = weekStart || mondayOfThisWeek();
    const startDate = new Date(start + "T00:00:00Z");
    const endDate = new Date(startDate.getTime() + 7 * 86400 * 1000);
    const out: Punishment[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0]);
      if (!date) continue;
      const d = new Date(date + "T00:00:00Z");
      if (d < startDate || d >= endDate) continue;
      const amount = Number(String(r[1] || "0").replace(/[^0-9.\-]/g, "")) || 0;
      out.push({
        date,
        amount,
        reason: r[2] || "",
        setBy: r[3] || "",
        paid: isTruthy(r[4]),
        ruleId: r[5] ? String(r[5]).trim() : undefined,
      });
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out;
  },
  ["dashboard:punishments:week"],
  { revalidate: 30 }
);

export const getCoachNotes = unstable_cache(
  async (limit = 3): Promise<CoachNote[]> => {
    const rows = await readTab("Coach Notes");
    if (!rows || rows.length < 2) return [];
    const out: CoachNote[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0]);
      if (!date) continue;
      out.push({ date, from: r[1] || "", note: r[2] || "" });
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out.slice(0, limit);
  },
  ["dashboard:coach-notes"],
  { revalidate: 30 }
);

export const getLatestWhoopDaily = unstable_cache(
  async (): Promise<WhoopDaily | null> => {
    const rows = await readTab("Whoop Daily");
    if (!rows || rows.length < 2) return null;
    // Skip rows that the sync wrote as placeholders before Whoop published
    // the day's metrics — every field empty. Falling back to the latest row
    // with actual data is what the tile expects (and what users want to see
    // before today's recovery is available).
    let best: WhoopDaily | null = null;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const d = normalizeDate(r[0]);
      if (!d) continue;
      const candidate: WhoopDaily = {
        date: d,
        recovery: String(r[1] ?? ""),
        strain: String(r[2] ?? ""),
        sleep: String(r[3] ?? ""),
        wakeTime: String(r[4] ?? ""),
        bedTime: String(r[5] ?? ""),
        rhr: String(r[6] ?? ""),
        hrv: String(r[7] ?? ""),
      };
      const hasData =
        candidate.recovery ||
        candidate.strain ||
        candidate.sleep ||
        candidate.wakeTime ||
        candidate.bedTime;
      if (!hasData) continue;
      if (!best || candidate.date > best.date) best = candidate;
    }
    return best;
  },
  ["dashboard:whoop:latest"],
  { revalidate: 30 }
);

/** Returns true if the Whoop Tokens tab has a populated token row. */
export const isWhoopConnected = unstable_cache(
  async (): Promise<boolean> => {
    const t = await getWhoopTokens();
    return Boolean(t && t.accessToken && t.refreshToken);
  },
  ["dashboard:whoop:connected"],
  { revalidate: 30 }
);

export const getWhoopDaily = unstable_cache(
  async (date?: string): Promise<WhoopDaily | null> => {
    const rows = await readTab("Whoop Daily");
    if (!rows || rows.length < 2) return null;
    const target = date || todayISO();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const d = normalizeDate(r[0]);
      if (d !== target) continue;
      return {
        date: d,
        recovery: r[1] || "",
        strain: r[2] || "",
        sleep: r[3] || "",
        wakeTime: r[4] || "",
        bedTime: r[5] || "",
        rhr: r[6] || "",
        hrv: r[7] || "",
      };
    }
    return null;
  },
  ["dashboard:whoop:today"],
  { revalidate: 30 }
);

export const getDailyLog = unstable_cache(
  async (date?: string): Promise<DailyLog | null> => {
    const rows = await readTab("Daily Log");
    if (!rows || rows.length < 2) return null;
    const target = date || todayISO();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const d = normalizeDate(r[0]);
      if (d !== target) continue;
      return {
        date: d,
        voiceNotes: r[1] || "",
        textNotes: r[2] || "",
        wakeTime: r[3] || "",
        bedTime: r[4] || "",
        notes: r[5] || "",
        harleyMeter: r[6] || "",
      };
    }
    return null;
  },
  ["dashboard:daily-log"],
  { revalidate: 30 }
);

// ---------- Admin: ensure tabs exist ----------

/**
 * Idempotently create any missing tabs from TAB_SCHEMAS and write headers.
 * Called by scripts/init-sheet.ts (run once after sharing the Sheet with
 * the service account). Safe to re-run.
 */
export async function ensureTabs(): Promise<{
  created: TabName[];
  existing: TabName[];
}> {
  const client = sheetsClient();
  const meta = await client.spreadsheets.get({ spreadsheetId: sheetId() });
  const existingTitles = new Set(
    (meta.data.sheets || [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t))
  );

  const created: TabName[] = [];
  const existing: TabName[] = [];
  const requests: sheets_v4.Schema$Request[] = [];

  for (const tab of Object.keys(TAB_SCHEMAS) as TabName[]) {
    if (existingTitles.has(tab)) {
      existing.push(tab);
    } else {
      created.push(tab);
      requests.push({ addSheet: { properties: { title: tab } } });
    }
  }

  if (requests.length > 0) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: sheetId(),
      requestBody: { requests },
    });
    // Write headers for newly created tabs.
    for (const tab of created) {
      const headers = TAB_SCHEMAS[tab];
      await client.spreadsheets.values.update({
        spreadsheetId: sheetId(),
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [Array.from(headers)] },
      });
    }
  }

  // Backfill columns added to TAB_SCHEMAS after a tab was first created.
  // Extends only — never shortens or reorders, so legacy data is safe.
  for (const tab of existing) {
    const wanted = TAB_SCHEMAS[tab];
    const current = await readTab(tab);
    const have = current?.[0] || [];
    if (have.length >= wanted.length) continue;
    await client.spreadsheets.values.update({
      spreadsheetId: sheetId(),
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [Array.from(wanted)] },
    });
  }

  return { created, existing };
}

/**
 * Append rows to a tab. Used by the seed script.
 */
export async function appendRows(
  tab: TabName,
  rows: (string | number)[][]
): Promise<void> {
  const client = sheetsClient();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: `${tab}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

// ---------- Whoop token storage ----------
//
// The Whoop Tokens tab holds at most ONE row of credentials at A2:D2.
// Reads bypass unstable_cache because we need fresh values immediately
// after a refresh. Same reason we don't cache the upsert path either.

export type WhoopTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  updatedAt: string; // ISO string
};

export async function getWhoopTokens(): Promise<WhoopTokens | null> {
  if (!isConfigured()) return null;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Whoop Tokens!A2:D2",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const row = (res.data.values || [])[0];
    if (!row || !row[0]) return null;
    if (!row[1]) {
      // Access token without refresh token. Whoop only issues refresh
      // tokens when the `offline` scope is requested — older OAuth
      // sessions before that scope was added end up here. The user
      // needs to reconnect via /api/whoop/connect.
      console.warn(
        "[sheets] Whoop Tokens row has access_token but no refresh_token. Reconnect via /api/whoop/connect (the 'offline' scope is now requested)."
      );
      return null;
    }
    const expiresAt = Number(row[2]);
    return {
      accessToken: String(row[0]),
      refreshToken: String(row[1]),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      updatedAt: String(row[3] || ""),
    };
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) {
      return null;
    }
    console.error("[sheets] error reading Whoop Tokens:", msg);
    return null;
  }
}

export async function saveWhoopTokens(t: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): Promise<void> {
  const client = sheetsClient();
  const updatedAt = new Date().toISOString();
  // Make sure the tab exists before updating. If a previous init-sheet
  // run predates Phase 2B, the Whoop Tokens tab won't be there yet —
  // auto-create it so the OAuth callback Just Works.
  await ensureTab("Whoop Tokens");
  await client.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: "Whoop Tokens!A2:D2",
    valueInputOption: "RAW",
    requestBody: {
      values: [[t.accessToken, t.refreshToken, t.expiresAt, updatedAt]],
    },
  });
}

/**
 * Idempotently ensure a single tab exists with its header row.
 * Cheaper than calling ensureTabs() when only one tab matters.
 */
async function ensureTab(tab: TabName): Promise<void> {
  const client = sheetsClient();
  const id = sheetId();
  const meta = await client.spreadsheets.get({ spreadsheetId: id });
  const titles = new Set(
    (meta.data.sheets || [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t))
  );
  if (titles.has(tab)) return;
  await client.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
  await client.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [Array.from(TAB_SCHEMAS[tab])] },
  });
}

// ---------- Whoop Daily upsert ----------

export type WhoopDailyRow = {
  date: string;
  recovery: number | string;
  strain: number | string;
  sleepHours: number | string;
  wakeTime: string;
  bedTime: string;
  rhr: number | string;
  hrv: number | string;
};

/**
 * Upsert a row in the Whoop Daily tab keyed by Date (column A).
 * If a row with the given date exists, replace it; otherwise append.
 */
export async function upsertWhoopDaily(row: WhoopDailyRow): Promise<{ action: "appended" | "updated"; rowIndex: number }> {
  const client = sheetsClient();
  const id = sheetId();
  const get = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Whoop Daily!A1:Z",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = (get.data.values || []) as (string | number)[][];
  const newValues: (string | number)[] = [
    row.date,
    row.recovery,
    row.strain,
    row.sleepHours,
    row.wakeTime,
    row.bedTime,
    row.rhr,
    row.hrv,
  ];
  // Find a matching date row (skip header at index 0)
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const d = normalizeDate(r[0] as string | number | undefined);
    if (d === row.date) {
      const sheetRow = i + 1; // 1-indexed
      // Preserve any existing non-empty cell when the new value is
      // empty. Whoop sometimes hasn't finished scoring at cron-run
      // time; later runs should fill in gaps without clobbering
      // previously-good data.
      const existing = r as (string | number)[];
      const merged = newValues.map((v, idx) =>
        isEmpty(v) ? existing[idx] ?? "" : v
      );
      await client.spreadsheets.values.update({
        spreadsheetId: id,
        range: `Whoop Daily!A${sheetRow}:H${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [merged] },
      });
      return { action: "updated", rowIndex: sheetRow };
    }
  }
  // Append
  await client.spreadsheets.values.append({
    spreadsheetId: id,
    range: "Whoop Daily!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [newValues] },
  });
  return { action: "appended", rowIndex: rows.length + 1 };
}

function isEmpty(v: string | number | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "number") return false;
  return String(v).trim() === "";
}

// ---------- Phase 2C: System Health + Sleep Edits ----------

export type SystemHealth = {
  timestamp: string;
  heartbeatOk: boolean;
  whoopOk: boolean;
  lastWhoopSync: string;
  recentSleepEdits: number;
  notes: string;
};

export type SleepEdit = {
  detectedAt: string;
  sleepId: string;
  fieldChanged: string;
  oldValue: string;
  newValue: string;
  source: string;
};

export async function appendSystemHealth(s: SystemHealth): Promise<void> {
  const client = sheetsClient();
  await ensureTab("System Health");
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "System Health!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        s.timestamp,
        s.heartbeatOk ? "yes" : "no",
        s.whoopOk ? "yes" : "no",
        s.lastWhoopSync,
        s.recentSleepEdits,
        s.notes,
      ]],
    },
  });
}

export async function appendSleepEdit(e: SleepEdit): Promise<void> {
  const client = sheetsClient();
  await ensureTab("Sleep Edits");
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Sleep Edits!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        e.detectedAt,
        e.sleepId,
        e.fieldChanged,
        e.oldValue,
        e.newValue,
        e.source,
      ]],
    },
  });
}

/**
 * Most recent System Health row, or null if tab is empty / missing.
 * Not cached — heartbeat caller wants a fresh read every tick.
 */
export async function getLatestSystemHealth(): Promise<SystemHealth | null> {
  if (!isConfigured()) return null;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "System Health!A1:F",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return null;
    const r = rows[rows.length - 1];
    return {
      timestamp: String(r[0] ?? ""),
      heartbeatOk: isTruthy(String(r[1] ?? "")),
      whoopOk: isTruthy(String(r[2] ?? "")),
      lastWhoopSync: String(r[3] ?? ""),
      recentSleepEdits: Number(r[4] ?? 0) || 0,
      notes: String(r[5] ?? ""),
    };
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return null;
    console.error("[sheets] error reading System Health:", msg);
    return null;
  }
}

/** Returns ALL System Health rows newest first — used for alert dedupe. */
export async function getSystemHealthHistory(limit = 200): Promise<SystemHealth[]> {
  if (!isConfigured()) return [];
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "System Health!A1:F",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return [];
    const out: SystemHealth[] = [];
    for (let i = rows.length - 1; i >= 1 && out.length < limit; i--) {
      const r = rows[i] || [];
      out.push({
        timestamp: String(r[0] ?? ""),
        heartbeatOk: isTruthy(String(r[1] ?? "")),
        whoopOk: isTruthy(String(r[2] ?? "")),
        lastWhoopSync: String(r[3] ?? ""),
        recentSleepEdits: Number(r[4] ?? 0) || 0,
        notes: String(r[5] ?? ""),
      });
    }
    return out;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
    console.error("[sheets] error reading System Health history:", msg);
    return [];
  }
}

export const getRecentSleepEdits = unstable_cache(
  async (limit = 5): Promise<SleepEdit[]> => {
    if (!isConfigured()) return [];
    try {
      const client = sheetsClient();
      const res = await client.spreadsheets.values.get({
        spreadsheetId: sheetId(),
        range: "Sleep Edits!A1:F",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const rows = (res.data.values || []) as (string | number)[][];
      if (rows.length < 2) return [];
      const out: SleepEdit[] = [];
      for (let i = rows.length - 1; i >= 1 && out.length < limit; i--) {
        const r = rows[i] || [];
        if (!r[0]) continue;
        out.push({
          detectedAt: String(r[0] ?? ""),
          sleepId: String(r[1] ?? ""),
          fieldChanged: String(r[2] ?? ""),
          oldValue: String(r[3] ?? ""),
          newValue: String(r[4] ?? ""),
          source: String(r[5] ?? ""),
        });
      }
      return out;
    } catch (e) {
      const msg = (e as Error).message || "";
      if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
      console.error("[sheets] error reading Sleep Edits:", msg);
      return [];
    }
  },
  ["dashboard:sleep-edits:recent"],
  { revalidate: 60 }
);

/** Cached read of latest System Health for the dashboard tile. */
export const getDashboardSystemHealth = unstable_cache(
  async (): Promise<SystemHealth | null> => getLatestSystemHealth(),
  ["dashboard:system-health"],
  { revalidate: 60 }
);

/**
 * Last `days` days of Whoop Daily rows, oldest first. Used by the
 * weekly summary email. Reads the whole tab and filters in JS — fine
 * for tabs with hundreds of rows; revisit if it grows past thousands.
 */
export async function getRecentWhoopDaily(days = 7): Promise<WhoopDaily[]> {
  const rows = await readTab("Whoop Daily");
  if (!rows || rows.length < 2) return [];
  const cutoffMs = Date.now() - days * 86400 * 1000;
  const out: WhoopDaily[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const d = normalizeDate(r[0]);
    if (!d) continue;
    const ms = Date.parse(d + "T12:00:00Z");
    if (isNaN(ms) || ms < cutoffMs) continue;
    out.push({
      date: d,
      recovery: String(r[1] ?? ""),
      strain: String(r[2] ?? ""),
      sleep: String(r[3] ?? ""),
      wakeTime: String(r[4] ?? ""),
      bedTime: String(r[5] ?? ""),
      rhr: String(r[6] ?? ""),
      hrv: String(r[7] ?? ""),
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// ---------- Amex Transactions ----------
//
// Append-only event log fed by /api/amex/inbound. Each row is one
// parsed Amex alert email. Email ID (RFC822 Message-ID) is the dedupe
// key — the inbound route checks for an existing row before appending.
// Type is "charge" for spend alerts, "balance" for the weekly balance
// summary, and "unparsed" when the parser can't extract structure (we
// still store the row so we can fix the parser without losing data).

export type AmexTransactionRow = {
  date: string;          // YYYY-MM-DD (transaction date if known, else email received date)
  type: "charge" | "balance" | "unparsed";
  merchant: string;
  amount: number;        // positive for charges, balance for "balance" type, 0 for unparsed
  currency: string;      // typically "AUD"
  cardLast4: string;     // "1234" or ""
  emailId: string;       // RFC822 Message-ID — dedupe key
  subject: string;       // original email subject for audit trail
  syncedAt: string;      // ISO timestamp when we received it
};

export async function appendAmexTransaction(row: AmexTransactionRow): Promise<void> {
  const client = sheetsClient();
  await ensureTab("Amex Transactions");
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Amex Transactions!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        row.date,
        row.type,
        row.merchant,
        row.amount,
        row.currency,
        row.cardLast4,
        row.emailId,
        row.subject,
        row.syncedAt,
      ]],
    },
  });
}

/**
 * Returns true if a row with this Email ID already exists. Used by the
 * inbound route to make POSTs idempotent — inbound providers retry on
 * non-2xx responses, so we MUST tolerate duplicate deliveries.
 */
export async function amexEmailIdExists(emailId: string): Promise<boolean> {
  if (!emailId) return false;
  if (!isConfigured()) return false;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Amex Transactions!G2:G",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as string[][];
    for (const r of rows) {
      if (r && r[0] === emailId) return true;
    }
    return false;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return false;
    console.error("[sheets] error checking amex emailId:", msg);
    return false;
  }
}

/**
 * Last `days` days of Amex transactions, newest first. Excludes
 * "balance" and "unparsed" rows by default — those are mostly diagnostic.
 */
export async function getRecentAmexTransactions(
  days = 30,
  opts: { includeBalance?: boolean; includeUnparsed?: boolean } = {}
): Promise<AmexTransactionRow[]> {
  if (!isConfigured()) return [];
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Amex Transactions!A1:I",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return [];
    const cutoffMs = Date.now() - days * 86400 * 1000;
    const out: AmexTransactionRow[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0] as string | number | undefined);
      if (!date) continue;
      const ms = Date.parse(date + "T12:00:00Z");
      if (isNaN(ms) || ms < cutoffMs) continue;
      const type = String(r[1] ?? "") as AmexTransactionRow["type"];
      if (type === "balance" && !opts.includeBalance) continue;
      if (type === "unparsed" && !opts.includeUnparsed) continue;
      out.push({
        date,
        type,
        merchant: String(r[2] ?? ""),
        amount: Number(r[3] ?? 0) || 0,
        currency: String(r[4] ?? ""),
        cardLast4: String(r[5] ?? ""),
        emailId: String(r[6] ?? ""),
        subject: String(r[7] ?? ""),
        syncedAt: String(r[8] ?? ""),
      });
    }
    return out.sort((a, b) =>
      a.syncedAt < b.syncedAt ? 1 : a.syncedAt > b.syncedAt ? -1 : 0
    );
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
    console.error("[sheets] error reading Amex Transactions:", msg);
    return [];
  }
}

/** Cached read for the dashboard tile (last 30 days, charges only). */
export const getDashboardAmex = unstable_cache(
  async (): Promise<AmexTransactionRow[]> => getRecentAmexTransactions(30),
  ["dashboard:amex"],
  { revalidate: 60 }
);

export type DashboardTransactions = {
  charges: AmexTransactionRow[];
  todayChargeTotal: number;
  sevenDayChargeTotal: number;
  thirtyDayChargeTotal: number;
  /** Most recent "balance" row from Amex weekly summaries. null if none. */
  latestBalance: { date: string; amount: number; currency: string } | null;
  hasAnyData: boolean;
};

/**
 * Aggregator for the TRANSACTIONS tile + /transactions page. Includes balance
 * rows so the tile can show the latest Amex balance alongside today/7d spend.
 * Excludes "unparsed" rows — those are diagnostic, not user-facing.
 */
export const getDashboardTransactions = unstable_cache(
  async (): Promise<DashboardTransactions> => {
    const all = await getRecentAmexTransactions(30, { includeBalance: true });
    const charges = all
      .filter((r) => r.type === "charge")
      // Sort by transaction date desc, then by syncedAt desc as tie-breaker
      // so same-day charges show in arrival order.
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.syncedAt < b.syncedAt ? 1 : a.syncedAt > b.syncedAt ? -1 : 0;
      });
    const balances = all
      .filter((r) => r.type === "balance")
      .sort((a, b) => (a.syncedAt < b.syncedAt ? 1 : -1));

    const today = todaySydneyISO();
    const sevenDayCutoff = new Date(Date.parse(today + "T00:00:00Z") - 6 * 86400000)
      .toISOString()
      .slice(0, 10);

    const todayChargeTotal = charges
      .filter((c) => c.date === today)
      .reduce((s, c) => s + (Number.isFinite(c.amount) ? c.amount : 0), 0);
    const sevenDayChargeTotal = charges
      .filter((c) => c.date >= sevenDayCutoff)
      .reduce((s, c) => s + (Number.isFinite(c.amount) ? c.amount : 0), 0);
    const thirtyDayChargeTotal = charges.reduce(
      (s, c) => s + (Number.isFinite(c.amount) ? c.amount : 0),
      0
    );

    const latest = balances[0];
    return {
      charges,
      todayChargeTotal,
      sevenDayChargeTotal,
      thirtyDayChargeTotal,
      latestBalance: latest
        ? { date: latest.date, amount: latest.amount, currency: latest.currency || "AUD" }
        : null,
      hasAnyData: all.length > 0,
    };
  },
  ["dashboard:transactions"],
  { revalidate: 60 }
);

// ---------- Harley Ledger ----------
//
// One running balance Daniel owes Harley. Two inputs:
//   1. Punishments tab — per-incident fines (existing). Each unpaid
//      row counts toward the balance until marked paid.
//   2. Harley Payments tab (new) — USDT/USDC withdrawals from
//      Crypto.com received via /api/crypto/inbound. Each row reduces
//      the balance.
//
// Plus an automatic monthly fine of $1000 appended on the 1st of
// each month by /api/cron/monthly-fine. Idempotent on the
// "Monthly fee — <Month> <Year>" Reason string so duplicate cron
// fires don't double-charge.

export type HarleyPaymentRow = {
  date: string;
  amount: number;
  currency: string;        // USDT / USDC
  network: string;
  toAddress: string;
  emailId: string;
  subject: string;
  syncedAt: string;
};

export async function appendHarleyPayment(row: HarleyPaymentRow): Promise<void> {
  const client = sheetsClient();
  await ensureTab("Harley Payments");
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Harley Payments!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        row.date,
        row.amount,
        row.currency,
        row.network,
        row.toAddress,
        row.emailId,
        row.subject,
        row.syncedAt,
      ]],
    },
  });
}

export async function harleyPaymentEmailIdExists(emailId: string): Promise<boolean> {
  if (!emailId || !isConfigured()) return false;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Harley Payments!F2:F",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as string[][];
    for (const r of rows) {
      if (r && r[0] === emailId) return true;
    }
    return false;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return false;
    console.error("[sheets] harleyPaymentEmailIdExists:", msg);
    return false;
  }
}

export async function getRecentHarleyPayments(days = 90): Promise<HarleyPaymentRow[]> {
  if (!isConfigured()) return [];
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Harley Payments!A1:H",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return [];
    const cutoffMs = Date.now() - days * 86400 * 1000;
    const out: HarleyPaymentRow[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0] as string | number | undefined);
      if (!date) continue;
      const ms = Date.parse(date + "T12:00:00Z");
      if (isNaN(ms) || ms < cutoffMs) continue;
      out.push({
        date,
        amount: Number(r[1] ?? 0) || 0,
        currency: String(r[2] ?? ""),
        network: String(r[3] ?? ""),
        toAddress: String(r[4] ?? ""),
        emailId: String(r[5] ?? ""),
        subject: String(r[6] ?? ""),
        syncedAt: String(r[7] ?? ""),
      });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
    console.error("[sheets] getRecentHarleyPayments:", msg);
    return [];
  }
}

/**
 * Read all unpaid Punishments (no week filter — everything counts
 * toward the running balance until marked paid).
 */
async function getAllUnpaidPunishments(): Promise<Punishment[]> {
  const rows = await readTab("Punishments");
  if (!rows || rows.length < 2) return [];
  const out: Punishment[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    const amount = Number(String(r[1] || "0").replace(/[^0-9.\-]/g, "")) || 0;
    const paid = isTruthy(r[4]);
    if (paid) continue;
    out.push({
      date,
      amount,
      reason: r[2] || "",
      setBy: r[3] || "",
      paid,
      ruleId: r[5] ? String(r[5]).trim() : undefined,
    });
  }
  return out;
}

export type HarleyBalance = {
  owed: number;
  finesTotal: number;
  paidTotal: number;
  fineCount: number;
  paymentCount: number;
  recentActivity: Array<
    | {
        kind: "fine";
        date: string;
        amount: number;
        reason: string;
        setBy: string;
        ruleId?: string;
      }
    | { kind: "payment"; date: string; amount: number; currency: string }
  >;
};

export const getHarleyBalance = unstable_cache(
  async (): Promise<HarleyBalance> => {
    const [punishments, payments] = await Promise.all([
      getAllUnpaidPunishments(),
      getRecentHarleyPayments(365),
    ]);
    const finesTotal = punishments.reduce((s, p) => s + p.amount, 0);
    // Trust 1:1 USDT/USDC = $ for now; flag in PR if precision matters.
    const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
    const merged: HarleyBalance["recentActivity"] = [
      ...punishments.map((p) => ({
        kind: "fine" as const,
        date: p.date,
        amount: p.amount,
        reason: p.reason,
        setBy: p.setBy,
        ruleId: p.ruleId,
      })),
      ...payments.map((p) => ({
        kind: "payment" as const,
        date: p.date,
        amount: p.amount,
        currency: p.currency,
      })),
    ].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
    return {
      owed: finesTotal - paidTotal,
      finesTotal,
      paidTotal,
      fineCount: punishments.length,
      paymentCount: payments.length,
      recentActivity: merged,
    };
  },
  ["dashboard:harley-balance"],
  { revalidate: 60 }
);

/**
 * Idempotent monthly-fine appender. Skips if a Punishment row with
 * Reason="Monthly fee — <Month> <Year>" already exists for the
 * current Sydney month. Returns whether a row was appended.
 *
 * If the `double_next_month` Setting is "yes" when this fires, the
 * appended amount is 2× and the Setting resets to "no" so doubling
 * applies to one month only.
 */
export async function appendMonthlyFineIfMissing(
  amount = 1000
): Promise<{
  appended: boolean;
  reason: string;
  monthLabel: string;
  doubled: boolean;
  finalAmount: number;
}> {
  const client = sheetsClient();
  const now = new Date();
  const monthLabel = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    month: "long",
    year: "numeric",
  }).format(now);
  const reason = `Monthly fee — ${monthLabel}`;

  // Read all reason cells (column C) to dedupe
  const rows = await readTab("Punishments");
  if (rows) {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      if (String(r[2] ?? "").trim() === reason) {
        return {
          appended: false,
          reason,
          monthLabel,
          doubled: false,
          finalAmount: amount,
        };
      }
    }
  }

  const settings = await readSettingsTab();
  const doubled =
    String(settings.get("double_next_month") ?? "")
      .trim()
      .toLowerCase() === "yes";
  const hardMode =
    String(settings.get("hard_mode") ?? "").trim().toLowerCase() === "yes";
  // Multipliers stack: hard_mode + double_next_month → 4× one-time.
  const multiplier = (doubled ? 2 : 1) * (hardMode ? 2 : 1);
  const finalAmount = amount * multiplier;
  const reasonModifiers: string[] = [];
  if (doubled) reasonModifiers.push("doubled");
  if (hardMode) reasonModifiers.push("hard-mode");
  const finalReason = reasonModifiers.length
    ? `${reason} (${reasonModifiers.join(" + ")})`
    : reason;

  const today = todaySydneyISO();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Punishments!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      // Empty 6th column — monthly fee isn't tied to a Harley Meter rule.
      values: [[today, finalAmount, finalReason, "auto", "no", ""]],
    },
  });

  // Toggle is single-shot — clear after the fine actually appended.
  if (doubled) {
    try {
      await setSetting("double_next_month", "no", "monthly-fine");
    } catch {
      // Don't fail the cron if the reset write hiccups; log and move on.
      console.error("[monthly-fine] failed to reset double_next_month");
    }
  }

  return { appended: true, reason: finalReason, monthLabel, doubled, finalAmount };
}

/**
 * Append a single Punishments row. Used by the /fine Telegram command
 * and the rule-eval cron. `ruleId` is the HarleyRuleId when the fine
 * traces to a Harley Meter rule; empty string for manual fines.
 *
 * `date` defaults to today (Sydney). For auto-rule-eval fines, callers
 * pass the violation period start so (ruleId, date) is the idempotency
 * key — the day of the missed wake, or the Monday of the failed week.
 */
export async function appendPunishment(opts: {
  amount: number;
  reason: string;
  setBy: string;
  ruleId?: string;
  date?: string;
}): Promise<void> {
  const client = sheetsClient();
  const date = opts.date || todaySydneyISO();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Punishments!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[date, opts.amount, opts.reason, opts.setBy, "no", opts.ruleId || ""]],
    },
  });
}

/**
 * Read all Punishments rows (paid and unpaid). Rule-eval cron uses this
 * to dedupe on (ruleId, date) before appending — once we've fined for a
 * rule on a given period, never fine again.
 */
export async function getAllPunishments(): Promise<Punishment[]> {
  const rows = await readTab("Punishments");
  if (!rows || rows.length < 2) return [];
  const out: Punishment[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    const amount = Number(String(r[1] || "0").replace(/[^0-9.\-]/g, "")) || 0;
    out.push({
      date,
      amount,
      reason: r[2] || "",
      setBy: r[3] || "",
      paid: isTruthy(r[4]),
      ruleId: r[5] ? String(r[5]).trim() : undefined,
    });
  }
  return out;
}

/**
 * A Punishment row tagged with its 1-based sheet rowIndex. The Goddess
 * panel uses the rowIndex as the canonical identifier when marking
 * fines paid or voiding them. Indices are stable until the next
 * deleteDimension; the panel revalidates after every mutation so
 * stale indices never make it back to the server.
 */
export type PunishmentWithRow = Punishment & { rowIndex: number };

/**
 * Recent unpaid Punishments, newest-first, with sheet rowIndex.
 * Uncached on purpose: the Goddess panel reads this immediately
 * after writes and needs to see fresh state.
 */
export async function getRecentUnpaidPunishments(
  limit = 10
): Promise<PunishmentWithRow[]> {
  const rows = await readTab("Punishments");
  if (!rows || rows.length < 2) return [];
  const out: PunishmentWithRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    if (isTruthy(r[4])) continue; // skip paid
    const amount = Number(String(r[1] || "0").replace(/[^0-9.\-]/g, "")) || 0;
    out.push({
      date,
      amount,
      reason: r[2] || "",
      setBy: r[3] || "",
      paid: false,
      ruleId: r[5] ? String(r[5]).trim() : undefined,
      rowIndex: i + 1, // sheet rows are 1-based
    });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out.slice(0, limit);
}

/** Cached numeric sheetId lookup for the Punishments tab. */
async function getPunishmentsNumericSheetId(): Promise<number> {
  const client = sheetsClient();
  const meta = await client.spreadsheets.get({ spreadsheetId: sheetId() });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties?.title === "Punishments"
  );
  const id = sheet?.properties?.sheetId;
  if (id == null) throw new Error("Punishments tab not found");
  return id;
}

/** Mark a single Punishment row paid (column E = "yes"). */
export async function markPunishmentPaid(rowIndex: number): Promise<void> {
  if (rowIndex < 2) throw new Error("invalid rowIndex");
  const client = sheetsClient();
  await client.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: `Punishments!E${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["yes"]] },
  });
}

/**
 * Delete a Punishment row entirely. "Void" semantics — for fat-finger
 * fines that should never have been recorded.
 *
 * Caller MUST refetch row indices after this call; subsequent rows
 * shift up by one, invalidating any held rowIndex.
 */
export async function voidPunishment(rowIndex: number): Promise<void> {
  if (rowIndex < 2) throw new Error("invalid rowIndex");
  const client = sheetsClient();
  const numericSheetId = await getPunishmentsNumericSheetId();
  await client.spreadsheets.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: numericSheetId,
              dimension: "ROWS",
              startIndex: rowIndex - 1, // API is 0-based
              endIndex: rowIndex,
            },
          },
        },
      ],
    },
  });
}

/**
 * Mark every unpaid Punishment row paid in a single batch. Used by the
 * Goddess panel "reset balance" action — for after Daniel actually
 * pays the running total in cash. Returns count of rows updated.
 */
export async function markAllUnpaidPaid(): Promise<number> {
  const rows = await readTab("Punishments");
  if (!rows || rows.length < 2) return 0;
  const updates: { range: string; values: string[][] }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    if (isTruthy(r[4])) continue;
    updates.push({
      range: `Punishments!E${i + 1}`,
      values: [["yes"]],
    });
  }
  if (updates.length === 0) return 0;
  const client = sheetsClient();
  await client.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: { valueInputOption: "USER_ENTERED", data: updates },
  });
  return updates.length;
}

// ---------- Goddess audit log ----------

export type GoddessAuditEntry = {
  timestamp: string;
  action: string;
  detail: string;
};

/**
 * Append a single audit row. Called by every server action in
 * src/app/harley/actions.ts. Failures are swallowed — never block a
 * primary action because the audit log can't be written.
 */
export async function appendGoddessAudit(
  action: string,
  detail: string
): Promise<void> {
  try {
    await ensureTab("Goddess Audit");
    const client = sheetsClient();
    await client.spreadsheets.values.append({
      spreadsheetId: sheetId(),
      range: "Goddess Audit!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[new Date().toISOString(), action, detail.slice(0, 500)]] },
    });
  } catch (e) {
    console.error("[goddess-audit] append failed:", (e as Error).message);
  }
}

/**
 * Read the most recent N audit entries, newest-first. Uncached so the
 * panel reflects the latest actions immediately.
 */
export async function getRecentGoddessAudit(
  limit = 5
): Promise<GoddessAuditEntry[]> {
  const rows = await readTab("Goddess Audit");
  if (!rows || rows.length < 2) return [];
  const out: GoddessAuditEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const ts = String(r[0] ?? "").trim();
    if (!ts) continue;
    out.push({
      timestamp: ts,
      action: String(r[1] ?? ""),
      detail: String(r[2] ?? ""),
    });
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out.slice(0, limit);
}
/**
 * Count Whoop workouts whose Date column is in [startISO, endISO]
 * inclusive (both YYYY-MM-DD). Used by rule-eval to score the gym rule
 * over an arbitrary Mon-Sun window.
 */
export async function countWhoopWorkoutsInRange(
  startISO: string,
  endISO: string
): Promise<number> {
  if (!isConfigured()) return 0;
  const rows = await readTab("Whoop Workouts");
  if (!rows || rows.length < 2) return 0;
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const d = normalizeDate(r[0] as string | number | undefined);
    if (!d) continue;
    if (d >= startISO && d <= endISO) count++;
  }
  return count;
}

// ---------- Apple Health ----------
//
// Fed by /api/health/ingest, posted to from an iOS Shortcut once a day
// (and on demand). Each row is one (Date, Source) combination — the
// Shortcut posts the same date repeatedly through the day, and we
// upsert in place so the row reflects the latest snapshot. Workouts
// are stored as a JSON-encoded string in the "Workouts JSON" column;
// readers parse on the way out.

export type AppleHealthWorkout = {
  type: string;
  durationMin: number;
  strain?: number;
  source: string;
};

export type AppleHealthRow = {
  date: string; // YYYY-MM-DD (Sydney)
  steps: number;
  workouts: AppleHealthWorkout[];
  activeCalories?: number;
  restingCalories?: number;
  source: string; // e.g. "ios-shortcut"
  syncedAt: string; // ISO
  waterMl?: number;
  /** HealthKit dietaryProtein (g). Source: MyFitnessPal/Cronometer → HealthKit. */
  proteinG?: number;
  /** HealthKit dietaryEnergyConsumed (kcal). Distinct from activeCalories (burned). */
  caloriesConsumed?: number;
};

/**
 * Upsert keyed on (Date, Source). The same Shortcut may post several
 * times a day with growing step counts — we always want the latest.
 */
export async function appendAppleHealth(
  row: AppleHealthRow
): Promise<{ action: "appended" | "updated"; rowIndex: number }> {
  const client = sheetsClient();
  const id = sheetId();
  await ensureTab("Apple Health");
  const get = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Apple Health!A1:J",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = (get.data.values || []) as (string | number)[][];
  const values = [
    row.date,
    row.steps,
    JSON.stringify(row.workouts || []),
    row.activeCalories ?? "",
    row.restingCalories ?? "",
    row.source,
    row.syncedAt,
    row.waterMl ?? "",
    row.proteinG ?? "",
    row.caloriesConsumed ?? "",
  ];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const d = normalizeDate(r[0] as string | number | undefined);
    const src = String(r[5] ?? "");
    if (d === row.date && src === row.source) {
      const sheetRow = i + 1;
      // Preserve prior readings when this payload's value is empty/zero
      // (treat 0 / undefined as "no fresh data" rather than "actually zero")
      // — Whoop sometimes hasn't pushed steps/active calories yet when the
      // Shortcut runs, and Ladder logs nutrition mid-day.
      const existing = r as (string | number)[];
      const merged = [...values];
      const preserve = (idx: number, fresh: number | undefined) => {
        if ((fresh === undefined || fresh === 0) && existing[idx] !== undefined && existing[idx] !== "") {
          merged[idx] = existing[idx];
        }
      };
      preserve(1, row.steps); // Steps
      preserve(3, row.activeCalories); // Active Calories
      preserve(4, row.restingCalories); // Resting Calories
      preserve(7, row.waterMl); // Water (ml)
      preserve(8, row.proteinG); // Protein (g)
      preserve(9, row.caloriesConsumed); // Calories Consumed
      await client.spreadsheets.values.update({
        spreadsheetId: id,
        range: `Apple Health!A${sheetRow}:J${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [merged] },
      });
      return { action: "updated", rowIndex: sheetRow };
    }
  }
  await client.spreadsheets.values.append({
    spreadsheetId: id,
    range: "Apple Health!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
  return { action: "appended", rowIndex: rows.length + 1 };
}

function parseWorkoutsCell(raw: string | number | undefined): AppleHealthWorkout[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function getRecentAppleHealth(days = 7): Promise<AppleHealthRow[]> {
  if (!isConfigured()) return [];
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Apple Health!A1:J",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return [];
    const cutoffMs = Date.now() - days * 86400 * 1000;
    const out: AppleHealthRow[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0] as string | number | undefined);
      if (!date) continue;
      const ms = Date.parse(date + "T12:00:00Z");
      if (isNaN(ms) || ms < cutoffMs) continue;
      out.push({
        date,
        steps: Number(r[1] ?? 0) || 0,
        workouts: parseWorkoutsCell(r[2] as string | undefined),
        activeCalories: r[3] === "" || r[3] === undefined ? undefined : Number(r[3]) || 0,
        restingCalories: r[4] === "" || r[4] === undefined ? undefined : Number(r[4]) || 0,
        source: String(r[5] ?? ""),
        syncedAt: String(r[6] ?? ""),
        waterMl: r[7] === "" || r[7] === undefined ? undefined : Number(r[7]) || 0,
        proteinG: r[8] === "" || r[8] === undefined ? undefined : Number(r[8]) || 0,
        caloriesConsumed:
          r[9] === "" || r[9] === undefined ? undefined : Number(r[9]) || 0,
      });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
    console.error("[sheets] error reading Apple Health:", msg);
    return [];
  }
}

export type DashboardAppleHealth = {
  todaySteps: number;
  todayWorkouts: AppleHealthWorkout[];
  weekStepsAvg: number;
  weekWorkoutCount: number;
  latestWorkout: { date: string; workout: AppleHealthWorkout } | null;
  workoutStreak: number;
  lastSynced: string;
};

// ---------- Denial Tracker ----------
//
// Single key/value config tab. Currently holds one row:
//   denial_end_date | ISO 8601 timestamp (e.g. 2026-05-20T23:59:00+10:00)
// Empty value means "no target set" — the dashboard treats that as released.

export const DENIAL_END_DATE_TAG = "denial:end-date";

export async function readDenialEndDate(): Promise<string | null> {
  const rows = await readTab("Denial");
  if (!rows || rows.length < 2) return null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const key = String(r[0] ?? "").trim();
    if (key !== "denial_end_date") continue;
    const value = String(r[1] ?? "").trim();
    return value || null;
  }
  return null;
}

export async function setDenialEndDate(value: string): Promise<void> {
  await ensureTab("Denial");
  const client = sheetsClient();
  const id = sheetId();
  const get = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Denial!A1:B",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (get.data.values || []) as (string | number)[][];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[0] ?? "").trim() === "denial_end_date") {
      const sheetRow = i + 1;
      await client.spreadsheets.values.update({
        spreadsheetId: id,
        range: `Denial!A${sheetRow}:B${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["denial_end_date", value]] },
      });
      return;
    }
  }
  await client.spreadsheets.values.append({
    spreadsheetId: id,
    range: "Denial!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["denial_end_date", value]] },
  });
}

export const getDenialEndDate = unstable_cache(
  async (): Promise<string | null> => {
    const rows = await readTab("Denial");
    if (!rows || rows.length < 2) return null;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const key = String(r[0] ?? "").trim();
      if (key !== "denial_end_date") continue;
      const value = String(r[1] ?? "").trim();
      return value || null;
    }
    return null;
  },
  ["dashboard:denial:end-date"],
  { revalidate: 30, tags: [DENIAL_END_DATE_TAG] }
);

export const getDashboardAppleHealth = unstable_cache(
  async (): Promise<DashboardAppleHealth> => {
    // Pull 60 days so the streak counter can look further back than the
    // 7-day step average needs.
    const recent = await getRecentAppleHealth(60);
    if (recent.length === 0) {
      return {
        todaySteps: 0,
        todayWorkouts: [],
        weekStepsAvg: 0,
        weekWorkoutCount: 0,
        latestWorkout: null,
        workoutStreak: 0,
        lastSynced: "",
      };
    }
    const today = todaySydneyISO();
    const sevenDaysAgoMs = Date.parse(today + "T00:00:00+10:00") - 6 * 86400 * 1000;

    const todayRows = recent.filter((r) => r.date === today);
    const todaySteps = todayRows.reduce((m, r) => Math.max(m, r.steps || 0), 0);
    const todayWorkouts = todayRows.flatMap((r) => r.workouts || []);

    // Steps per day (max across sources). Average over days that have any
    // step data in the last 7 (avoids dragging the average down with
    // zeros for days the Shortcut didn't sync).
    const stepsByDay = new Map<string, number>();
    const workoutsByDay = new Map<string, AppleHealthWorkout[]>();
    for (const r of recent) {
      const ms = Date.parse(r.date + "T12:00:00Z");
      if (!isNaN(ms)) {
        const cur = stepsByDay.get(r.date) ?? 0;
        if (r.steps > cur) stepsByDay.set(r.date, r.steps);
        if (r.workouts.length > 0) {
          const existing = workoutsByDay.get(r.date) ?? [];
          workoutsByDay.set(r.date, [...existing, ...r.workouts]);
        }
      }
    }
    const weekStepsList: number[] = [];
    for (const [date, steps] of stepsByDay) {
      const ms = Date.parse(date + "T12:00:00Z");
      if (ms >= sevenDaysAgoMs && steps > 0) weekStepsList.push(steps);
    }
    const weekStepsAvg = weekStepsList.length
      ? Math.round(weekStepsList.reduce((a, b) => a + b, 0) / weekStepsList.length)
      : 0;

    let weekWorkoutCount = 0;
    for (const [date, ws] of workoutsByDay) {
      const ms = Date.parse(date + "T12:00:00Z");
      if (ms >= sevenDaysAgoMs) weekWorkoutCount += ws.length;
    }

    // Latest workout = the most recent date with any workout, taking the
    // last workout in that day's list.
    let latestWorkout: DashboardAppleHealth["latestWorkout"] = null;
    const datesWithWorkouts = Array.from(workoutsByDay.keys()).sort().reverse();
    if (datesWithWorkouts.length > 0) {
      const d = datesWithWorkouts[0];
      const list = workoutsByDay.get(d) || [];
      if (list.length > 0) latestWorkout = { date: d, workout: list[list.length - 1] };
    }

    // Streak = consecutive days ending today with at least one workout.
    // If today has no workout yet, the streak walks back from yesterday
    // — we don't penalise the user for checking the dashboard at 9am.
    let streak = 0;
    const startDate = (workoutsByDay.get(today)?.length ?? 0) > 0
      ? today
      : new Date(Date.parse(today + "T00:00:00+10:00") - 86400 * 1000)
          .toISOString()
          .slice(0, 10);
    let cursor = startDate;
    while (workoutsByDay.has(cursor) && (workoutsByDay.get(cursor)?.length ?? 0) > 0) {
      streak++;
      const prev = new Date(Date.parse(cursor + "T00:00:00Z") - 86400 * 1000);
      cursor = prev.toISOString().slice(0, 10);
    }

    const lastSynced = recent
      .map((r) => r.syncedAt)
      .filter(Boolean)
      .sort()
      .reverse()[0] || "";
    return {
      todaySteps,
      todayWorkouts,
      weekStepsAvg,
      weekWorkoutCount,
      latestWorkout,
      workoutStreak: streak,
      lastSynced,
    };
  },
  ["dashboard:apple-health"],
  { revalidate: 60 }
);

// ---------- Nutrition (protein / calories consumed / water) ----------

export type DashboardNutrition = {
  date: string;
  proteinG: number;
  caloriesConsumed: number;
  waterMl: number;
  proteinTarget: number;
  calorieTarget: number;
  waterTargetMl: number;
  /** True when the latest reading came in today (Sydney). */
  hasToday: boolean;
};

/**
 * Today's dietary protein / calories / water from the Apple Health rows
 * (one row per source per day — we take the max across sources for
 * each metric, matching how steps and active-calories are aggregated).
 * Falls back to the most recent day with any data when today is empty,
 * but flags that via `hasToday=false` so the tile can dim.
 */
export const getDashboardNutrition = unstable_cache(
  async (): Promise<DashboardNutrition> => {
    const [recent, settings] = await Promise.all([
      getRecentAppleHealth(7),
      getWeaknessSettings(),
    ]);
    const today = todaySydneyISO();
    // Pick the most recent date that has any nutrition data.
    const byDate = new Map<string, AppleHealthRow[]>();
    for (const r of recent) {
      const list = byDate.get(r.date) || [];
      list.push(r);
      byDate.set(r.date, list);
    }
    const datesDesc = Array.from(byDate.keys()).sort().reverse();
    let pickDate = "";
    let proteinG = 0;
    let caloriesConsumed = 0;
    let waterMl = 0;
    for (const d of datesDesc) {
      const list = byDate.get(d) || [];
      const p = list.reduce((m, r) => Math.max(m, r.proteinG ?? 0), 0);
      const c = list.reduce((m, r) => Math.max(m, r.caloriesConsumed ?? 0), 0);
      const w = list.reduce((m, r) => Math.max(m, r.waterMl ?? 0), 0);
      if (p > 0 || c > 0 || w > 0) {
        pickDate = d;
        proteinG = p;
        caloriesConsumed = c;
        waterMl = w;
        break;
      }
    }
    return {
      date: pickDate || today,
      proteinG,
      caloriesConsumed,
      waterMl,
      proteinTarget: settings.nutrition_protein_target_g,
      calorieTarget: settings.nutrition_calorie_target,
      waterTargetMl: settings.nutrition_water_target_ml,
      hasToday: pickDate === today && (proteinG > 0 || caloriesConsumed > 0 || waterMl > 0),
    };
  },
  ["dashboard:nutrition"],
  { revalidate: 60 }
);

// ---------- Whoop Workouts ----------
//
// Server-side mirror of Whoop's /activity/workout feed. Fed by the
// daily whoop-sync cron, which fetches the target date's workouts
// after upserting the daily rollup. Idempotent on Workout ID
// (column B) — the cron checks before appending, so re-running the
// sync for the same day doesn't duplicate.
//
// Drives the GYM tile (today / week count / streak / latest). Apple
// Health workouts (from the iOS Shortcut payload) are intentionally
// not merged here — Whoop is the authoritative source for now.

export type WhoopWorkoutRow = {
  date: string;
  workoutId: string;
  sportId: number | null;
  strain: number | null;
  durationMin: number;
  avgHr: number | null;
  maxHr: number | null;
  kilojoules: number | null;
  start: string;
  end: string;
  syncedAt: string;
};

export async function whoopWorkoutIdExists(workoutId: string): Promise<boolean> {
  if (!workoutId || !isConfigured()) return false;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Whoop Workouts!B2:B",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    for (const r of rows) {
      if (r && String(r[0]) === workoutId) return true;
    }
    return false;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return false;
    console.error("[sheets] whoopWorkoutIdExists:", msg);
    return false;
  }
}

export async function appendWhoopWorkout(row: WhoopWorkoutRow): Promise<void> {
  const client = sheetsClient();
  await ensureTab("Whoop Workouts");
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Whoop Workouts!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        row.date,
        row.workoutId,
        row.sportId ?? "",
        row.strain ?? "",
        row.durationMin,
        row.avgHr ?? "",
        row.maxHr ?? "",
        row.kilojoules ?? "",
        row.start,
        row.end,
        row.syncedAt,
      ]],
    },
  });
}

export type DashboardWhoopWorkout = {
  date: string;
  workoutId: string;
  sportName: string;
  sportId: number | null;
  strain: number | null;
  durationMin: number;
};

export type DashboardWhoopWorkouts = {
  todayWorkouts: DashboardWhoopWorkout[];
  weekWorkoutCount: number;
  latestWorkout: DashboardWhoopWorkout | null;
  workoutStreak: number;
  lastSynced: string;
};

const EMPTY_WHOOP_WORKOUTS: DashboardWhoopWorkouts = {
  todayWorkouts: [],
  weekWorkoutCount: 0,
  latestWorkout: null,
  workoutStreak: 0,
  lastSynced: "",
};

export const getDashboardWhoopWorkouts = unstable_cache(
  async (): Promise<DashboardWhoopWorkouts> => {
    if (!isConfigured()) return EMPTY_WHOOP_WORKOUTS;
    try {
      const client = sheetsClient();
      const res = await client.spreadsheets.values.get({
        spreadsheetId: sheetId(),
        range: "Whoop Workouts!A1:K",
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      });
      const rows = (res.data.values || []) as (string | number)[][];
      if (rows.length < 2) return EMPTY_WHOOP_WORKOUTS;

      const today = todaySydneyISO();
      const sevenDaysAgoMs = Date.parse(today + "T00:00:00+10:00") - 6 * 86400 * 1000;

      const all: (DashboardWhoopWorkout & { syncedAt: string })[] = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        const date = normalizeDate(r[0] as string | number | undefined);
        if (!date) continue;
        const sportId =
          r[2] === "" || r[2] === undefined || r[2] === null ? null : Number(r[2]);
        all.push({
          date,
          workoutId: String(r[1] ?? ""),
          sportName: whoopSportName(sportId),
          sportId,
          strain:
            r[3] === "" || r[3] === undefined || r[3] === null ? null : Number(r[3]),
          durationMin: Number(r[4]) || 0,
          syncedAt: String(r[10] ?? ""),
        });
      }

      // Newest first by date, then by sync recency as tiebreaker.
      all.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return a.syncedAt < b.syncedAt ? 1 : a.syncedAt > b.syncedAt ? -1 : 0;
      });

      const todayWorkouts = all.filter((w) => w.date === today).map(strip);
      const workoutsByDay = new Map<string, number>();
      for (const w of all) {
        workoutsByDay.set(w.date, (workoutsByDay.get(w.date) ?? 0) + 1);
      }

      let weekWorkoutCount = 0;
      for (const [date, count] of workoutsByDay) {
        const ms = Date.parse(date + "T12:00:00Z");
        if (!isNaN(ms) && ms >= sevenDaysAgoMs) weekWorkoutCount += count;
      }

      const latestWorkout = all[0] ? strip(all[0]) : null;

      // Streak ends at today (or yesterday if today is empty so morning
      // viewers don't see an artificial reset).
      const todayCount = workoutsByDay.get(today) ?? 0;
      let cursor = todayCount > 0
        ? today
        : new Date(Date.parse(today + "T00:00:00+10:00") - 86400 * 1000)
            .toISOString()
            .slice(0, 10);
      let streak = 0;
      while ((workoutsByDay.get(cursor) ?? 0) > 0) {
        streak++;
        cursor = new Date(Date.parse(cursor + "T00:00:00Z") - 86400 * 1000)
          .toISOString()
          .slice(0, 10);
      }

      const lastSynced = all
        .map((w) => w.syncedAt)
        .filter(Boolean)
        .sort()
        .reverse()[0] || "";

      return { todayWorkouts, weekWorkoutCount, latestWorkout, workoutStreak: streak, lastSynced };
    } catch (e) {
      const msg = (e as Error).message || "";
      if (msg.includes("Unable to parse range") || msg.includes("not found")) {
        return EMPTY_WHOOP_WORKOUTS;
      }
      console.error("[sheets] getDashboardWhoopWorkouts:", msg);
      return EMPTY_WHOOP_WORKOUTS;
    }
  },
  ["dashboard:whoop-workouts"],
  { revalidate: 60 }
);

function strip(w: DashboardWhoopWorkout & { syncedAt: string }): DashboardWhoopWorkout {
  const { syncedAt: _ignored, ...rest } = w;
  void _ignored;
  return rest;
}

// Best-effort Whoop sport_id → friendly name. Whoop has ~80 sports;
// only the ones likely to appear are mapped here. Unknown IDs render
// as "Workout" — refine when a recurring sport_id surfaces in the data.
function whoopSportName(sportId: number | null): string {
  if (sportId === null) return "Workout";
  const map: Record<number, string> = {
    [-1]: "Activity",
    0: "Running",
    1: "Cycling",
    16: "Baseball",
    33: "Yoga",
    45: "Weightlifting",
    48: "Functional Fitness",
    52: "HIIT",
    62: "Pilates",
    63: "Walking",
    71: "Hiking",
  };
  return map[sportId] ?? "Workout";
}

// ---------- Screen Time ----------
//
// Append-only event log fed by /api/screentime/ingest. iOS Shortcut and
// Mac launchd both POST daily aggregates. Readers dedupe to the latest
// (date, source, label) tuple by syncedAt — re-posts are cheap and
// preserve an audit trail.

export type ScreenTimeRow = {
  date: string;
  source: string; // "ios_shortcut" | "mac_launchd" (open-ended for future sources)
  label: string;
  category: string;
  minutes: number;
  syncedAt: string;
};

export async function appendScreentimeRows(rows: ScreenTimeRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = sheetsClient();
  await ensureTab("Screen Time");
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Screen Time!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: rows.map((r) => [
        r.date,
        r.source,
        r.label,
        r.category,
        r.minutes,
        r.syncedAt,
      ]),
    },
  });
}

export async function getRecentScreentime(days = 7): Promise<ScreenTimeRow[]> {
  if (!isConfigured()) return [];
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Screen Time!A1:F",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return [];
    const cutoffMs = Date.now() - days * 86400 * 1000;
    const all: ScreenTimeRow[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = normalizeDate(r[0] as string | number | undefined);
      if (!date) continue;
      const ms = Date.parse(date + "T12:00:00Z");
      if (isNaN(ms) || ms < cutoffMs) continue;
      all.push({
        date,
        source: String(r[1] ?? ""),
        label: String(r[2] ?? ""),
        category: String(r[3] ?? ""),
        minutes: Number(r[4] ?? 0) || 0,
        syncedAt: String(r[5] ?? ""),
      });
    }
    // Dedupe to latest per (date, source, label) by syncedAt.
    const map = new Map<string, ScreenTimeRow>();
    for (const r of all) {
      const key = `${r.date}|${r.source}|${r.label}`;
      const existing = map.get(key);
      if (!existing || r.syncedAt > existing.syncedAt) map.set(key, r);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.label.localeCompare(b.label)
    );
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return [];
    console.error("[sheets] error reading Screen Time:", msg);
    return [];
  }
}

export const getDashboardScreentime = unstable_cache(
  async (): Promise<ScreenTimeRow[]> => getRecentScreentime(7),
  ["dashboard:screentime"],
  { revalidate: 60 }
);

// ---------- Phase 5B: Goddess's Weakening Altar ----------
//
// Tabs: Orgasm Log, Edge Log, Daily Check-in, Settings.
//
// Reuses the file-level todaySydneyISO() helper exported above so wall-clock
// dates are correct for the user; the rest of the codebase uses UTC dates.

function nowSydneyTimeHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function nowSydneyISO(): string {
  return `${todaySydneyISO()}T${nowSydneyTimeHHMM()}`;
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// ---------- Orgasm Log ----------

export type OrgasmType = "allowed" | "lapsed";

export type OrgasmLogRow = {
  date: string;
  time: string;
  type: OrgasmType;
  note: string;
  daysSincePrevious: number | null;
};

async function readOrgasmLog(): Promise<OrgasmLogRow[]> {
  const rows = await readTab("Orgasm Log");
  if (!rows || rows.length < 2) return [];
  const out: OrgasmLogRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    const rawType = String(r[2] ?? "").trim().toLowerCase();
    const type: OrgasmType = rawType === "lapsed" ? "lapsed" : "allowed";
    const days = r[4] === "" || r[4] === undefined ? null : Number(r[4]);
    out.push({
      date,
      time: String(r[1] ?? ""),
      type,
      note: String(r[3] ?? ""),
      daysSincePrevious: Number.isFinite(days as number) ? (days as number) : null,
    });
  }
  out.sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));
  return out;
}

export async function getMostRecentOrgasm(): Promise<OrgasmLogRow | null> {
  const rows = await readOrgasmLog();
  return rows.length ? rows[rows.length - 1] : null;
}

export async function getMostRecentAllowedOrgasm(): Promise<OrgasmLogRow | null> {
  const rows = await readOrgasmLog();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === "allowed") return rows[i];
  }
  return null;
}

export async function appendOrgasmLog(input: {
  type: OrgasmType;
  note?: string;
}): Promise<{ date: string; daysSincePrevious: number | null }> {
  await ensureTab("Orgasm Log");
  const date = todaySydneyISO();
  const time = nowSydneyTimeHHMM();
  const previous = await getMostRecentOrgasm();
  const daysSince = previous ? daysBetween(previous.date, date) : null;
  const client = sheetsClient();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Orgasm Log!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        date,
        time,
        input.type,
        input.note || "",
        daysSince === null ? "" : daysSince,
      ]],
    },
  });
  return { date, daysSincePrevious: daysSince };
}

export async function getOrgasmsLast30Days(): Promise<OrgasmLogRow[]> {
  const all = await readOrgasmLog();
  const cutoffMs = Date.now() - 30 * 86400000;
  return all.filter((o) => {
    const ms = Date.parse(o.date + "T12:00:00Z");
    return !isNaN(ms) && ms >= cutoffMs;
  });
}

// ---------- Edge Log ----------

export type EdgeLogRow = {
  date: string;
  time: string;
  note: string;
};

async function readEdgeLog(): Promise<EdgeLogRow[]> {
  const rows = await readTab("Edge Log");
  if (!rows || rows.length < 2) return [];
  const out: EdgeLogRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    out.push({
      date,
      time: String(r[1] ?? ""),
      note: String(r[2] ?? ""),
    });
  }
  return out;
}

export async function appendEdgeLog(input: { note?: string } = {}): Promise<{
  date: string;
  countToday: number;
}> {
  await ensureTab("Edge Log");
  const date = todaySydneyISO();
  const time = nowSydneyTimeHHMM();
  const client = sheetsClient();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Edge Log!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[date, time, input.note || ""]],
    },
  });
  // Count today AFTER the append so the caller can use it for thresholds.
  const all = await readEdgeLog();
  const countToday = all.filter((e) => e.date === date).length;
  return { date, countToday };
}

export async function getEdgeLogsSinceLastOrgasm(): Promise<EdgeLogRow[]> {
  const [edges, mostRecent] = await Promise.all([
    readEdgeLog(),
    getMostRecentOrgasm(),
  ]);
  if (!mostRecent) return edges;
  const cutoff = `${mostRecent.date}T${mostRecent.time || "00:00"}`;
  return edges.filter((e) => `${e.date}T${e.time || "00:00"}` > cutoff);
}

export async function getEdgeLogsLast30Days(): Promise<EdgeLogRow[]> {
  const all = await readEdgeLog();
  const cutoffMs = Date.now() - 30 * 86400000;
  return all.filter((e) => {
    const ms = Date.parse(e.date + "T12:00:00Z");
    return !isNaN(ms) && ms >= cutoffMs;
  });
}

// ---------- Daily Check-in (upsert on Date) ----------

export type DailyCheckInRow = {
  date: string;
  arousal: number;
  note: string;
};

async function readDailyCheckIns(): Promise<DailyCheckInRow[]> {
  const rows = await readTab("Daily Check-in");
  if (!rows || rows.length < 2) return [];
  const out: DailyCheckInRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    const arousal = Number(r[1] ?? 0);
    if (!Number.isFinite(arousal)) continue;
    out.push({
      date,
      arousal,
      note: String(r[2] ?? ""),
    });
  }
  return out;
}

export async function appendDailyCheckIn(input: {
  arousal: number;
  note?: string;
}): Promise<{ date: string; action: "appended" | "updated" }> {
  await ensureTab("Daily Check-in");
  const client = sheetsClient();
  const id = sheetId();
  const date = todaySydneyISO();
  const get = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Daily Check-in!A1:C",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = (get.data.values || []) as (string | number)[][];
  const values = [date, input.arousal, input.note || ""];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const d = normalizeDate(r[0] as string | number | undefined);
    if (d === date) {
      const sheetRow = i + 1;
      await client.spreadsheets.values.update({
        spreadsheetId: id,
        range: `Daily Check-in!A${sheetRow}:C${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [values] },
      });
      return { date, action: "updated" };
    }
  }
  await client.spreadsheets.values.append({
    spreadsheetId: id,
    range: "Daily Check-in!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
  return { date, action: "appended" };
}

export async function getCheckInsSinceLastOrgasm(): Promise<DailyCheckInRow[]> {
  const [checkIns, mostRecent] = await Promise.all([
    readDailyCheckIns(),
    getMostRecentOrgasm(),
  ]);
  if (!mostRecent) return checkIns;
  return checkIns.filter((c) => c.date >= mostRecent.date);
}

export async function getCheckInsLast30Days(): Promise<DailyCheckInRow[]> {
  const all = await readDailyCheckIns();
  const cutoffMs = Date.now() - 30 * 86400000;
  return all.filter((c) => {
    const ms = Date.parse(c.date + "T12:00:00Z");
    return !isNaN(ms) && ms >= cutoffMs;
  });
}

export async function hasArousalCheckInToday(): Promise<boolean> {
  const today = todaySydneyISO();
  const all = await readDailyCheckIns();
  return all.some((c) => c.date === today);
}

// ---------- Worship Log ----------
//
// Append-only minutes-of-worship log. Each row pushes weakness score UP by
// (minutes × worship_weight_per_minute) on the day it was logged.

export type WorshipLogRow = {
  date: string;
  time: string;
  activity: string;
  minutes: number;
  note: string;
};

async function readWorshipLog(): Promise<WorshipLogRow[]> {
  const rows = await readTab("Worship Log");
  if (!rows || rows.length < 2) return [];
  const out: WorshipLogRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    const minutes = Number(r[3] ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    out.push({
      date,
      time: String(r[1] ?? ""),
      activity: String(r[2] ?? ""),
      minutes,
      note: String(r[4] ?? ""),
    });
  }
  return out;
}

export async function appendWorshipLog(input: {
  activity: string;
  minutes: number;
  note?: string;
}): Promise<{ date: string; minutes: number }> {
  await ensureTab("Worship Log");
  const date = todaySydneyISO();
  const time = nowSydneyTimeHHMM();
  const minutes = Math.max(0, Math.round(input.minutes));
  const client = sheetsClient();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Worship Log!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[date, time, input.activity || "", minutes, input.note || ""]],
    },
  });
  return { date, minutes };
}

// ---------- Self-Help Log ----------
//
// Append-only minutes-of-self-help log. Each row pulls weakness score DOWN by
// (minutes × self_help_weight_per_minute) on the day it was logged.

export type SelfHelpLogRow = {
  date: string;
  time: string;
  activity: string;
  minutes: number;
  note: string;
};

async function readSelfHelpLog(): Promise<SelfHelpLogRow[]> {
  const rows = await readTab("Self-Help Log");
  if (!rows || rows.length < 2) return [];
  const out: SelfHelpLogRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const date = normalizeDate(r[0]);
    if (!date) continue;
    const minutes = Number(r[3] ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    out.push({
      date,
      time: String(r[1] ?? ""),
      activity: String(r[2] ?? ""),
      minutes,
      note: String(r[4] ?? ""),
    });
  }
  return out;
}

export async function appendSelfHelpLog(input: {
  activity: string;
  minutes: number;
  note?: string;
}): Promise<{ date: string; minutes: number }> {
  await ensureTab("Self-Help Log");
  const date = todaySydneyISO();
  const time = nowSydneyTimeHHMM();
  const minutes = Math.max(0, Math.round(input.minutes));
  const client = sheetsClient();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Self-Help Log!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[date, time, input.activity || "", minutes, input.note || ""]],
    },
  });
  return { date, minutes };
}

// ---------- Settings ----------

export type WeaknessSettings = {
  orgasm_allowed: "yes" | "no";
  weakness_base_daily: number;
  weakness_arousal_weight: number;
  default_arousal_when_missing: number;
  /** Potency of edge #1 of the cycle, #1 of the day. */
  weakness_edge_first: number;
  /** Decay applied per cycle edge (across days). */
  weakness_edge_cycle_decay: number;
  /** Decay applied per same-day edge (within a day). */
  weakness_edge_day_decay: number;
  /** Day-edge count above which the brutal multiplier starts ramping. */
  brutal_bonus_threshold: number;
  /** Multiplier increment per day-edge above threshold. */
  brutal_bonus_per_edge: number;
  /** Hard cap on the brutal multiplier. */
  brutal_bonus_max_multiplier: number;
  /** Linear addition per day-edge after the multiplier plateau. */
  brutal_bonus_post_plateau_linear: number;
  /** Active calories below this trigger no detraction (units must match Apple Health payload). */
  calorie_burn_threshold: number;
  /** Detraction at exactly the threshold. */
  calorie_burn_base_detraction: number;
  /** Additional detraction per unit above the threshold. */
  calorie_burn_per_unit_above: number;
  /** Score added per minute of worship time logged. */
  worship_weight_per_minute: number;
  /** Score detracted per minute of self-help time logged. */
  self_help_weight_per_minute: number;
  /**
   * Flat score deduction applied on the day of each lapsed orgasm. Default
   * is 40% of the start of the final phase (2151) so anyone in the first
   * 40% of the curve effectively resets to 0; high-score days lose a
   * meaningful chunk but stay weak. Cumulative score still floors at 0.
   */
  slip_penalty_points: number;
  /** Daily protein target (g) for the NUTRITION tile progress bar. */
  nutrition_protein_target_g: number;
  /** Daily calories-consumed target (kcal) for the NUTRITION tile. */
  nutrition_calorie_target: number;
  /** Daily water target (ml) for the NUTRITION tile. */
  nutrition_water_target_ml: number;
  phase_thresholds: Record<string, [number, number, string]>;
};

export const DEFAULT_PHASE_THRESHOLDS: WeaknessSettings["phase_thresholds"] = {
  "Post-Nut Devotee": [0, 150, "Most resistant right after release."],
  "Denying the Ache": [151, 320, "Trying to ignore the growing need."],
  "Building Weakness": [321, 520, "Weakness is starting to build."],
  "Fading Subbie": [521, 720, "Resistance is fading fast."],
  "Breaking Adorer": [721, 920, "Mind starting to melt for Her."],
  Submitting: [921, 1150, "Giving in, obedience taking over."],
  "Deep Submission": [1151, 1350, "Deeper and deeper under Her control."],
  "Helpless Vessel": [1351, 1550, "No control left. Just a vessel."],
  "Mindless Offering": [1551, 1750, "Brainless tribute for Goddess."],
  "Complete Slave": [1751, 2150, "No self. Pure property."],
  "Eternal Edge Toy": [2151, 999999, "Conditioned to edge endlessly. The end."],
};

export const DEFAULT_WEAKNESS_SETTINGS: WeaknessSettings = {
  orgasm_allowed: "no",
  weakness_base_daily: 26,
  weakness_arousal_weight: 25,
  default_arousal_when_missing: 5,
  weakness_edge_first: 30,
  weakness_edge_cycle_decay: 0.9,
  weakness_edge_day_decay: 0.6,
  brutal_bonus_threshold: 10,
  brutal_bonus_per_edge: 0.05,
  brutal_bonus_max_multiplier: 5.0,
  brutal_bonus_post_plateau_linear: 20,
  calorie_burn_threshold: 487,
  calorie_burn_base_detraction: 30,
  calorie_burn_per_unit_above: 0.2,
  worship_weight_per_minute: 5,
  self_help_weight_per_minute: 3,
  slip_penalty_points: 860,
  nutrition_protein_target_g: 221,
  nutrition_calorie_target: 2940,
  nutrition_water_target_ml: 3350,
  phase_thresholds: DEFAULT_PHASE_THRESHOLDS,
};

/** Seed rows for the Settings tab — written once when the tab is created. */
export const SETTINGS_SEED_ROWS: (string | number)[][] = [
  ["orgasm_allowed", "no", "", "system"],
  ["weakness_base_daily", 26, "", "system"],
  ["weakness_arousal_weight", 25, "", "system"],
  ["default_arousal_when_missing", 5, "", "system"],
  ["weakness_edge_first", 30, "", "system"],
  ["weakness_edge_cycle_decay", 0.9, "", "system"],
  ["weakness_edge_day_decay", 0.6, "", "system"],
  ["brutal_bonus_threshold", 10, "", "system"],
  ["brutal_bonus_per_edge", 0.05, "", "system"],
  ["brutal_bonus_max_multiplier", 5.0, "", "system"],
  ["brutal_bonus_post_plateau_linear", 20, "", "system"],
  ["calorie_burn_threshold", 487, "", "system"],
  ["calorie_burn_base_detraction", 30, "", "system"],
  ["calorie_burn_per_unit_above", 0.2, "", "system"],
  ["worship_weight_per_minute", 5, "", "system"],
  ["self_help_weight_per_minute", 3, "", "system"],
  ["slip_penalty_points", 860, "", "system"],
  ["nutrition_protein_target_g", 221, "", "system"],
  ["nutrition_calorie_target", 2940, "", "system"],
  ["nutrition_water_target_ml", 3350, "", "system"],
  ["phase_thresholds", JSON.stringify(DEFAULT_PHASE_THRESHOLDS), "", "system"],
];

async function readSettingsTab(): Promise<Map<string, string>> {
  const rows = await readTab("Settings");
  const map = new Map<string, string>();
  if (!rows || rows.length < 2) return map;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const key = String(r[0] ?? "").trim();
    if (!key) continue;
    map.set(key, String(r[1] ?? ""));
  }
  return map;
}

/**
 * Typed Setting accessor. `phase_thresholds` is parsed as JSON; everything
 * else returns the raw string. Returns null if the row is missing.
 */
export async function getSetting(name: string): Promise<unknown | null> {
  const map = await readSettingsTab();
  if (!map.has(name)) return null;
  const raw = map.get(name)!;
  if (name === "phase_thresholds") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

export async function setSetting(
  name: string,
  value: string | number,
  updatedBy = "dashboard"
): Promise<void> {
  await ensureTab("Settings");
  const client = sheetsClient();
  const id = sheetId();
  const get = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Settings!A1:D",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (get.data.values || []) as (string | number)[][];
  const updatedAt = nowSydneyISO();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[0] ?? "").trim() === name) {
      const sheetRow = i + 1;
      await client.spreadsheets.values.update({
        spreadsheetId: id,
        range: `Settings!A${sheetRow}:D${sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[name, value, updatedAt, updatedBy]] },
      });
      return;
    }
  }
  await client.spreadsheets.values.append({
    spreadsheetId: id,
    range: "Settings!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[name, value, updatedAt, updatedBy]] },
  });
}

/**
 * Single round-trip read of all weakness-related settings. Falls back to
 * DEFAULT_WEAKNESS_SETTINGS for any missing key.
 */
export async function getWeaknessSettings(): Promise<WeaknessSettings> {
  const map = await readSettingsTab();
  const num = (key: keyof WeaknessSettings, fallback: number): number => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  let phaseThresholds = DEFAULT_PHASE_THRESHOLDS;
  const rawPhases = map.get("phase_thresholds");
  if (rawPhases) {
    try {
      const parsed = JSON.parse(rawPhases);
      if (parsed && typeof parsed === "object") {
        phaseThresholds = parsed as WeaknessSettings["phase_thresholds"];
      }
    } catch {
      // keep defaults
    }
  }
  const allowed = (map.get("orgasm_allowed") ?? "no").trim().toLowerCase();
  return {
    orgasm_allowed: allowed === "yes" ? "yes" : "no",
    weakness_base_daily: num("weakness_base_daily", DEFAULT_WEAKNESS_SETTINGS.weakness_base_daily),
    weakness_arousal_weight: num("weakness_arousal_weight", DEFAULT_WEAKNESS_SETTINGS.weakness_arousal_weight),
    default_arousal_when_missing: num("default_arousal_when_missing", DEFAULT_WEAKNESS_SETTINGS.default_arousal_when_missing),
    weakness_edge_first: num("weakness_edge_first", DEFAULT_WEAKNESS_SETTINGS.weakness_edge_first),
    weakness_edge_cycle_decay: num("weakness_edge_cycle_decay", DEFAULT_WEAKNESS_SETTINGS.weakness_edge_cycle_decay),
    weakness_edge_day_decay: num("weakness_edge_day_decay", DEFAULT_WEAKNESS_SETTINGS.weakness_edge_day_decay),
    brutal_bonus_threshold: num("brutal_bonus_threshold", DEFAULT_WEAKNESS_SETTINGS.brutal_bonus_threshold),
    brutal_bonus_per_edge: num("brutal_bonus_per_edge", DEFAULT_WEAKNESS_SETTINGS.brutal_bonus_per_edge),
    brutal_bonus_max_multiplier: num("brutal_bonus_max_multiplier", DEFAULT_WEAKNESS_SETTINGS.brutal_bonus_max_multiplier),
    brutal_bonus_post_plateau_linear: num("brutal_bonus_post_plateau_linear", DEFAULT_WEAKNESS_SETTINGS.brutal_bonus_post_plateau_linear),
    calorie_burn_threshold: num("calorie_burn_threshold", DEFAULT_WEAKNESS_SETTINGS.calorie_burn_threshold),
    calorie_burn_base_detraction: num("calorie_burn_base_detraction", DEFAULT_WEAKNESS_SETTINGS.calorie_burn_base_detraction),
    calorie_burn_per_unit_above: num("calorie_burn_per_unit_above", DEFAULT_WEAKNESS_SETTINGS.calorie_burn_per_unit_above),
    worship_weight_per_minute: num("worship_weight_per_minute", DEFAULT_WEAKNESS_SETTINGS.worship_weight_per_minute),
    self_help_weight_per_minute: num("self_help_weight_per_minute", DEFAULT_WEAKNESS_SETTINGS.self_help_weight_per_minute),
    slip_penalty_points: num("slip_penalty_points", DEFAULT_WEAKNESS_SETTINGS.slip_penalty_points),
    nutrition_protein_target_g: num(
      "nutrition_protein_target_g",
      DEFAULT_WEAKNESS_SETTINGS.nutrition_protein_target_g
    ),
    nutrition_calorie_target: num(
      "nutrition_calorie_target",
      DEFAULT_WEAKNESS_SETTINGS.nutrition_calorie_target
    ),
    nutrition_water_target_ml: num(
      "nutrition_water_target_ml",
      DEFAULT_WEAKNESS_SETTINGS.nutrition_water_target_ml
    ),
    phase_thresholds: phaseThresholds,
  };
}

/** Cached read of just orgasm_allowed for the layout background swap. */
export const getOrgasmAllowed = unstable_cache(
  async (): Promise<"yes" | "no"> => {
    const map = await readSettingsTab();
    const v = (map.get("orgasm_allowed") ?? "no").trim().toLowerCase();
    return v === "yes" ? "yes" : "no";
  },
  ["dashboard:orgasm-allowed"],
  { revalidate: 30 }
);

/**
 * Aggregator pulled by the dashboard tile in one Promise.all. Pulls everything
 * over the network; computeWeaknessScore (in src/lib/weakness.ts) does the math
 * locally so this stays a thin sheet-IO wrapper.
 */
export async function getWeaknessRawData(): Promise<{
  orgasms: OrgasmLogRow[];
  edges: EdgeLogRow[];
  checkIns: DailyCheckInRow[];
  worship: WorshipLogRow[];
  selfHelp: SelfHelpLogRow[];
  appleHealth: AppleHealthRow[];
  settings: WeaknessSettings;
  hasArousalCheckInToday: boolean;
  mostRecentOrgasm: OrgasmLogRow | null;
}> {
  const [orgasms, edges, checkIns, worship, selfHelp, appleHealth, settings] =
    await Promise.all([
      readOrgasmLog(),
      readEdgeLog(),
      readDailyCheckIns(),
      readWorshipLog(),
      readSelfHelpLog(),
      // 60 days covers a long denial cycle — calorie detraction needs to be
      // available for any day in the cumulative-score iteration.
      getRecentAppleHealth(60),
      getWeaknessSettings(),
    ]);
  const today = todaySydneyISO();
  return {
    orgasms,
    edges,
    checkIns,
    worship,
    selfHelp,
    appleHealth,
    settings,
    hasArousalCheckInToday: checkIns.some((c) => c.date === today),
    mostRecentOrgasm: orgasms.length ? orgasms[orgasms.length - 1] : null,
  };
}

// ---------- Magic Links + audit (Telegram /harley auth) ----------
//
// Two append-mostly tabs:
//   Magic Links: one row per issued token, marked used_at on consumption.
//   Magic Link Audit: forensic event log (request, send_*, verify_*,
//   rate_limit_hit). Read-only from app code outside this section.
//
// Both auto-create on first write via ensureTab(). No init-sheet seeding
// needed — the tabs come into existence the first time Harley clicks
// "Send access link to Telegram".

export type MagicLinkRow = {
  token: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  ip: string;
};

export async function appendMagicLink(
  token: string,
  expiresAtISO: string,
  ip: string
): Promise<void> {
  const client = sheetsClient();
  await ensureTab("Magic Links");
  const createdAt = new Date().toISOString();
  await client.spreadsheets.values.append({
    spreadsheetId: sheetId(),
    range: "Magic Links!A1",
    valueInputOption: "RAW",
    requestBody: { values: [[token, createdAt, expiresAtISO, "", ip]] },
  });
}

export async function findMagicLink(token: string): Promise<MagicLinkRow | null> {
  if (!token) return null;
  if (!isConfigured()) return null;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Magic Links!A1:E",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (String(r[0] ?? "") !== token) continue;
      return {
        token,
        createdAt: String(r[1] ?? ""),
        expiresAt: String(r[2] ?? ""),
        usedAt: r[3] ? String(r[3]) : null,
        ip: String(r[4] ?? ""),
      };
    }
    return null;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return null;
    console.error("[sheets] error reading Magic Links:", msg);
    return null;
  }
}

export async function markMagicLinkUsed(token: string): Promise<void> {
  const client = sheetsClient();
  const id = sheetId();
  const res = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Magic Links!A1:F",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values || []) as (string | number)[][];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[0] ?? "") !== token) continue;
    const sheetRow = i + 1;
    await client.spreadsheets.values.update({
      spreadsheetId: id,
      range: `Magic Links!D${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[new Date().toISOString()]] },
    });
    return;
  }
}

/**
 * One-off audit helper: for every Magic Links row whose Created at
 * timestamp falls within [startMs, endMs], stamp the Note column with
 * the supplied label. The original Used at value is preserved if it
 * was already set (a real login event), otherwise it's stamped to now
 * so the row is visually closed. Skips rows that already have a Note,
 * making the helper idempotent across re-runs.
 *
 * The data row is preserved (deletion would lose the audit trail).
 * The Note column flags the row as anomalous regardless of whether
 * the magic link was ultimately consumed by the original (wrong)
 * recipient.
 *
 * Returns matched (rows in window) and updated (rows actually written).
 */
export async function purgeMagicLinksInWindow(opts: {
  startMs: number;
  endMs: number;
  note: string;
}): Promise<{ matched: number; updated: number }> {
  const client = sheetsClient();
  const id = sheetId();
  const res = await client.spreadsheets.values.get({
    spreadsheetId: id,
    range: "Magic Links!A1:F",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values || []) as (string | number)[][];
  const now = new Date().toISOString();
  let matched = 0;
  let updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const createdAt = String(r[1] ?? "");
    if (!createdAt) continue;
    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) continue;
    if (ts < opts.startMs || ts > opts.endMs) continue;
    matched++;
    const existingUsedAt = r[3] ? String(r[3]) : "";
    const existingNote = r[5] ? String(r[5]) : "";
    if (existingNote) continue; // idempotent: already noted
    const newUsedAt = existingUsedAt || now;
    const sheetRow = i + 1;
    await client.spreadsheets.values.update({
      spreadsheetId: id,
      range: `Magic Links!D${sheetRow}:F${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[newUsedAt, String(r[4] ?? ""), opts.note]] },
    });
    updated++;
  }
  return { matched, updated };
}

export async function appendMagicLinkAudit(
  ip: string,
  action: string,
  detail: string
): Promise<void> {
  try {
    const client = sheetsClient();
    await ensureTab("Magic Link Audit");
    await client.spreadsheets.values.append({
      spreadsheetId: sheetId(),
      range: "Magic Link Audit!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [[new Date().toISOString(), ip, action, detail]],
      },
    });
  } catch (e) {
    // Audit must never throw — losing a row is preferable to breaking
    // the request flow. Log and move on.
    console.error("[sheets] audit write failed:", (e as Error).message);
  }
}

/**
 * Count audit rows for a given IP whose action == "request" and whose
 * timestamp is at or after the given epoch milliseconds. Used by the
 * login-request rate limiter (3/hour, 10/day).
 */
export async function countMagicLinkRequests(
  ip: string,
  sinceMs: number
): Promise<number> {
  if (!isConfigured()) return 0;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Magic Link Audit!A1:D",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    let count = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      if (String(r[1] ?? "") !== ip) continue;
      if (String(r[2] ?? "") !== "request") continue;
      const ts = Date.parse(String(r[0] ?? ""));
      if (!isNaN(ts) && ts >= sinceMs) count++;
    }
    return count;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return 0;
    console.error("[sheets] error reading Magic Link Audit:", msg);
    return 0;
  }
}

// ---------- Sync Triggers ----------
//
// Audit log of /api/sync/trigger invocations from /harley. Append-only.
// Like Magic Link Audit, the write must never throw — losing a row is
// preferable to breaking the sync flow.

export async function appendSyncTrigger(input: {
  ip: string;
  whoop: string;
  manualAsks: string[];
  emailSent: boolean;
  source: "harley" | "dashboard";
}): Promise<void> {
  try {
    const client = sheetsClient();
    await ensureTab("Sync Triggers");
    await client.spreadsheets.values.append({
      spreadsheetId: sheetId(),
      range: "Sync Triggers!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          new Date().toISOString(),
          input.ip,
          input.whoop,
          input.manualAsks.join(" | "),
          input.emailSent ? "yes" : "no",
          input.source,
        ]],
      },
    });
  } catch (e) {
    console.error("[sheets] sync trigger audit write failed:", (e as Error).message);
  }
}

/**
 * Used by the dashboard button to enforce 1/min/IP rate limit. Reads
 * the last 100 audit rows and looks for a same-IP, same-source entry
 * within the cutoff window. Returns null if none found, or the most
 * recent matching timestamp ISO so the caller can compute retry-after.
 */
export async function getMostRecentSyncTriggerForIp(
  ip: string,
  source: "harley" | "dashboard"
): Promise<string | null> {
  if (!isConfigured() || !ip) return null;
  try {
    const client = sheetsClient();
    const res = await client.spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range: "Sync Triggers!A1:F",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values || []) as (string | number)[][];
    if (rows.length < 2) return null;
    // Walk newest-first (rows append in order so end is newest)
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      if (!r) continue;
      const rowIp = String(r[1] ?? "");
      const rowSource = String(r[5] ?? "");
      if (rowIp === ip && rowSource === source) {
        return String(r[0] ?? "");
      }
    }
    return null;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("Unable to parse range") || msg.includes("not found")) return null;
    console.error("[sheets] getMostRecentSyncTriggerForIp:", msg);
    return null;
  }
}

// ---------- Calendar Events snapshot ----------

export type CalendarSnapshotRow = {
  eventId: string;
  etag: string;
  summary: string;
  startISO: string;
  firstSeenAt: string;
  notifiedAt: string;
};

export async function readCalendarSnapshot(): Promise<CalendarSnapshotRow[]> {
  const rows = await readTab("Calendar Events");
  if (!rows || rows.length < 2) return [];
  const out: CalendarSnapshotRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    out.push({
      eventId: String(r[0] || ""),
      etag: String(r[1] || ""),
      summary: String(r[2] || ""),
      startISO: String(r[3] || ""),
      firstSeenAt: String(r[4] || ""),
      notifiedAt: String(r[5] || ""),
    });
  }
  return out;
}

/**
 * Replace the Calendar Events tab body with `rows`. Header row is left
 * intact. Caller is responsible for preserving firstSeenAt / notifiedAt
 * across rewrites by merging against the prior snapshot.
 */
export async function writeCalendarSnapshot(
  rows: CalendarSnapshotRow[]
): Promise<void> {
  await ensureTab("Calendar Events");
  const client = sheetsClient();
  const id = sheetId();
  await client.spreadsheets.values.clear({
    spreadsheetId: id,
    range: "Calendar Events!A2:F",
  });
  if (rows.length === 0) return;
  const values = rows.map((r) => [
    r.eventId,
    r.etag,
    r.summary,
    r.startISO,
    r.firstSeenAt,
    r.notifiedAt,
  ]);
  await client.spreadsheets.values.update({
    spreadsheetId: id,
    range: `Calendar Events!A2:F${rows.length + 1}`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}
