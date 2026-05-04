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

const SHEET_ID = process.env.SHEET_ID || "";
const SERVICE_ACCOUNT_JSON_RAW = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";

export function isConfigured(): boolean {
  return Boolean(SHEET_ID && SERVICE_ACCOUNT_JSON_RAW);
}

// Tab schemas — keep in sync with the schema we create in ensureTabs().
export const TAB_SCHEMAS = {
  Tasks: ["Date", "Task", "Set by", "Done?", "Completed at", "Proof link"],
  Punishments: ["Date", "Amount", "Reason", "Set by", "Paid?"],
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
} as const;

export type TabName = keyof typeof TAB_SCHEMAS;

// ---------- Auth ----------

let cachedClient: sheets_v4.Sheets | null = null;

function sheetsClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  if (!isConfigured()) {
    throw new Error(
      "Google Sheets not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON and SHEET_ID."
    );
  }
  let creds;
  try {
    creds = JSON.parse(SERVICE_ACCOUNT_JSON_RAW);
  } catch (e) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${(e as Error).message}`
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
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
      spreadsheetId: SHEET_ID,
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

export const getHarleyMeter = unstable_cache(
  async (): Promise<number> => {
    const rows = await readTab("Daily Log");
    if (!rows || rows.length < 2) return 0;
    // Walk from bottom looking for the most recent non-empty harleyMeter cell.
    for (let i = rows.length - 1; i >= 1; i--) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const v = r[6];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
        if (!isNaN(n)) return n;
      }
    }
    return 0;
  },
  ["dashboard:harley-meter"],
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
  const meta = await client.spreadsheets.get({ spreadsheetId: SHEET_ID });
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
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
    // Write headers for newly created tabs.
    for (const tab of created) {
      const headers = TAB_SCHEMAS[tab];
      await client.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [Array.from(headers)] },
      });
    }
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
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}
