/**
 * Whoop API client.
 *
 * Token storage lives in the "Whoop Tokens" tab of the Sheet (single
 * row at A2:D2). getValidToken() reads it, refreshes when within 60s of
 * expiry, and writes the new tokens back. Each fetch retries once on a
 * 401 by force-refreshing.
 *
 * OAuth + base URLs are pulled from env so we can swap to sandbox if
 * Whoop ever offers one. Defaults match the values from the brief.
 */
import { getWhoopTokens, saveWhoopTokens } from "./sheets";

const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer/v1";

export const WHOOP_SCOPES = [
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:profile",
  "read:body_measurement",
  "read:workout",
];

// Refresh tokens if they expire within this window.
const REFRESH_BUFFER_MS = 60 * 1000;

// ---------- Config ----------

function clientId(): string {
  return process.env.WHOOP_CLIENT_ID || "";
}
function clientSecret(): string {
  return process.env.WHOOP_CLIENT_SECRET || "";
}
function redirectUri(): string {
  return process.env.WHOOP_REDIRECT_URI || "";
}

export function whoopOAuthConfigured(): boolean {
  return Boolean(clientId() && clientSecret() && redirectUri());
}

// ---------- OAuth helpers ----------

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri(),
    scope: WHOOP_SCOPES.join(" "),
    state,
  });
  return `${WHOOP_AUTHORIZE_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope?: string;
};

async function postTokenForm(
  body: Record<string, string>
): Promise<TokenResponse> {
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Whoop token endpoint ${res.status}: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  return postTokenForm({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: clientId(),
    client_secret: clientSecret(),
  });
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return postTokenForm({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    scope: WHOOP_SCOPES.join(" "),
  });
}

/**
 * Persist the token response to the Sheet. Returns the saved access_token.
 */
async function persist(t: TokenResponse): Promise<string> {
  const expiresAt = Date.now() + t.expires_in * 1000;
  await saveWhoopTokens({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt,
  });
  return t.access_token;
}

export async function saveInitialTokens(t: TokenResponse): Promise<void> {
  await persist(t);
}

/**
 * Read tokens from the Sheet, refresh if expired or near-expiry, return
 * a usable access token. Throws if no tokens stored at all (caller
 * should redirect user to /api/whoop/connect).
 */
export async function getValidToken(): Promise<string> {
  const stored = await getWhoopTokens();
  if (!stored) {
    throw new Error("Whoop not connected. Hit /api/whoop/connect first.");
  }
  if (stored.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return stored.accessToken;
  }
  // Refresh
  const refreshed = await refreshTokens(stored.refreshToken);
  return persist(refreshed);
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let token = await getValidToken();
  let res = await fetch(`${WHOOP_API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  if (res.status === 401) {
    // Force a refresh by clearing expiry: just call refresh directly.
    const stored = await getWhoopTokens();
    if (!stored) throw new Error("Whoop tokens disappeared mid-request.");
    const refreshed = await refreshTokens(stored.refreshToken);
    token = await persist(refreshed);
    res = await fetch(`${WHOOP_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  }
  return res;
}

// ---------- Domain types (subset of Whoop API responses) ----------

export type RecoveryItem = {
  cycle_id: number;
  sleep_id?: number;
  user_id?: number;
  created_at?: string;
  updated_at?: string;
  score_state?: string;
  score?: {
    user_calibrating?: boolean;
    recovery_score?: number;
    resting_heart_rate?: number;
    hrv_rmssd_milli?: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
};

export type CycleItem = {
  id: number;
  start: string;
  end?: string;
  timezone_offset?: string;
  score_state?: string;
  score?: {
    strain?: number;
    kilojoule?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
  };
};

export type SleepItem = {
  id: number;
  start: string;
  end: string;
  timezone_offset?: string;
  nap?: boolean;
  score_state?: string;
  score?: {
    stage_summary?: {
      total_in_bed_time_milli?: number;
      total_awake_time_milli?: number;
      total_no_data_time_milli?: number;
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
      sleep_cycle_count?: number;
      disturbance_count?: number;
    };
    sleep_needed?: {
      baseline_milli?: number;
      need_from_sleep_debt_milli?: number;
      need_from_recent_strain_milli?: number;
      need_from_recent_nap_milli?: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
};

export type WorkoutItem = {
  id: number;
  start: string;
  end: string;
  sport_id?: number;
  score_state?: string;
  score?: {
    strain?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
    kilojoule?: number;
  };
};

export type BodyMeasurement = {
  height_meter?: number;
  weight_kilogram?: number;
  max_heart_rate?: number;
};

// ---------- Range helpers ----------

/**
 * Return [start,end] ISO strings spanning the given YYYY-MM-DD calendar day in UTC.
 * Whoop expects ISO 8601; we use start-of-day to start-of-next-day.
 */
function dayRangeUTC(dateISO: string): { start: string; end: string } {
  const start = new Date(dateISO + "T00:00:00Z");
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function fetchCollection<T>(
  path: string,
  params: Record<string, string>
): Promise<T[]> {
  const qs = new URLSearchParams(params);
  const res = await authedFetch(`${path}?${qs.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whoop ${path} ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { records?: T[]; next_token?: string };
  return data.records || [];
}

// ---------- Public API ----------

/** Recovery items overlapping the given date (UTC day). Most recent first. */
export async function getRecovery(dateISO: string): Promise<RecoveryItem[]> {
  const { start, end } = dayRangeUTC(dateISO);
  return fetchCollection<RecoveryItem>("/recovery", {
    start,
    end,
    limit: "10",
  });
}

/** Cycles overlapping the given date. Most recent first. */
export async function getCycle(dateISO: string): Promise<CycleItem[]> {
  const { start, end } = dayRangeUTC(dateISO);
  return fetchCollection<CycleItem>("/cycle", { start, end, limit: "10" });
}

/** Sleeps overlapping the given date. Most recent first. */
export async function getSleep(dateISO: string): Promise<SleepItem[]> {
  const { start, end } = dayRangeUTC(dateISO);
  return fetchCollection<SleepItem>("/activity/sleep", {
    start,
    end,
    limit: "10",
  });
}

/** Workouts overlapping the given date. */
export async function getWorkouts(dateISO: string): Promise<WorkoutItem[]> {
  const { start, end } = dayRangeUTC(dateISO);
  return fetchCollection<WorkoutItem>("/activity/workout", {
    start,
    end,
    limit: "25",
  });
}

/** Most recent body measurement (single object). */
export async function getBodyMeasurement(): Promise<BodyMeasurement | null> {
  const res = await authedFetch("/user/measurement/body");
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whoop body measurement ${res.status}: ${body}`);
  }
  return (await res.json()) as BodyMeasurement;
}

// ---------- Aggregator for the daily-sync row ----------

export type DailyRollup = {
  date: string;
  recovery: number | "";
  strain: number | "";
  sleepHours: number | "";
  wakeTime: string;
  bedTime: string;
  rhr: number | "";
  hrv: number | "";
};

function fmtClock(d: Date): string {
  return d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Australia/Sydney",
  });
}

/**
 * Build a single Whoop Daily row for `dateISO` by pulling Recovery + Cycle
 * + Sleep in parallel and picking the most-recent score for each.
 */
export async function getDailyRollup(dateISO: string): Promise<DailyRollup> {
  const [recoveries, cycles, sleeps] = await Promise.all([
    getRecovery(dateISO).catch((e) => {
      console.error("[whoop] recovery fetch failed:", (e as Error).message);
      return [] as RecoveryItem[];
    }),
    getCycle(dateISO).catch((e) => {
      console.error("[whoop] cycle fetch failed:", (e as Error).message);
      return [] as CycleItem[];
    }),
    getSleep(dateISO).catch((e) => {
      console.error("[whoop] sleep fetch failed:", (e as Error).message);
      return [] as SleepItem[];
    }),
  ]);

  // Latest recovery for the day
  const r = recoveries[0];
  const recoveryScore = r?.score?.recovery_score;
  const rhr = r?.score?.resting_heart_rate;
  const hrv = r?.score?.hrv_rmssd_milli;

  // Highest strain cycle for the day (cycles roll over at the user's
  // local "day-start" time so multiple may overlap; pick the max)
  const strain = cycles
    .map((c) => c?.score?.strain)
    .filter((s): s is number => typeof s === "number")
    .reduce<number | undefined>((acc, s) => (acc === undefined || s > acc ? s : acc), undefined);

  // Pick the longest non-nap sleep that ended on this date, else longest
  const dayStart = new Date(dateISO + "T00:00:00Z").getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const validSleeps = sleeps.filter((s) => !s.nap && s.start && s.end);
  const sleepCandidates = validSleeps.filter((s) => {
    const e = new Date(s.end).getTime();
    return e >= dayStart && e <= dayEnd + 6 * 3600 * 1000;
  });
  const chosenSleep = (sleepCandidates.length ? sleepCandidates : validSleeps)
    .slice()
    .sort((a, b) => {
      const aDur = new Date(a.end).getTime() - new Date(a.start).getTime();
      const bDur = new Date(b.end).getTime() - new Date(b.start).getTime();
      return bDur - aDur;
    })[0];

  let sleepHours: number | "" = "";
  let wakeTime = "";
  let bedTime = "";
  if (chosenSleep) {
    const ms = new Date(chosenSleep.end).getTime() - new Date(chosenSleep.start).getTime();
    sleepHours = Math.round((ms / 3600000) * 10) / 10; // 1 decimal
    bedTime = fmtClock(new Date(chosenSleep.start));
    wakeTime = fmtClock(new Date(chosenSleep.end));
  }

  return {
    date: dateISO,
    recovery: typeof recoveryScore === "number" ? recoveryScore : "",
    strain: typeof strain === "number" ? Math.round(strain * 10) / 10 : "",
    sleepHours,
    wakeTime,
    bedTime,
    rhr: typeof rhr === "number" ? rhr : "",
    hrv: typeof hrv === "number" ? Math.round(hrv) : "",
  };
}
