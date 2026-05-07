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
// Whoop API v2 — recovery and sleep moved here (v1 returns 404 for those).
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer/v2";

// `offline` is REQUIRED for Whoop to return a refresh_token. Without it
// the token endpoint returns access_token only — and the cron has no
// way to refresh, so we'd silently lose access after ~1h.
export const WHOOP_SCOPES = [
  "offline",
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
  id: string | number; // v2 returns UUID string; v1 returned number
  cycle_id?: number;
  v1_id?: number | null;
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

const USER_TIMEZONE = process.env.USER_TIMEZONE || "Australia/Sydney";

/**
 * Return [start,end] UTC ISO strings spanning the user's local calendar
 * day (defaults to Australia/Sydney). Widened by ±12h on each side so
 * we capture sleeps that started the previous evening or recovery
 * scores tagged shortly after midnight. Filtering down to "this day"
 * happens later in getDailyRollup.
 */
function dayRangeForLocalDate(dateISO: string): { start: string; end: string } {
  // Compute local midnight as UTC by abusing Intl: ask for the offset of
  // a fixed point in time inside USER_TIMEZONE on dateISO and apply it.
  const localMidnightUTC = (() => {
    // Pick noon UTC as the reference instant (avoids DST-boundary drift)
    const ref = new Date(`${dateISO}T12:00:00Z`);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: USER_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(ref).map((p) => [p.type, p.value])
    );
    // Calendar date in the user's TZ at "noon UTC" — should match dateISO
    // unless dateISO is far in the past/future in UTC, in which case we
    // use the local-tz interpretation regardless.
    void parts; // referenced for clarity
    // Compute offset in minutes between UTC and the user's TZ at this instant
    const utcStr = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, "0")}-${String(ref.getUTCDate()).padStart(2, "0")} ${String(ref.getUTCHours()).padStart(2, "0")}:${String(ref.getUTCMinutes()).padStart(2, "0")}`;
    const localStr = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    const utcMs = Date.parse(utcStr.replace(" ", "T") + ":00Z");
    const localMs = Date.parse(localStr.replace(" ", "T") + ":00Z");
    const offsetMs = localMs - utcMs;
    // Local midnight in UTC ms = parse(dateISO T00:00) in user-TZ - offset
    const localMidnight = Date.parse(`${dateISO}T00:00:00Z`) - offsetMs;
    return new Date(localMidnight);
  })();
  const start = new Date(localMidnightUTC.getTime() - 12 * 3600 * 1000);
  const end = new Date(localMidnightUTC.getTime() + 36 * 3600 * 1000);
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
  const { start, end } = dayRangeForLocalDate(dateISO);
  return fetchCollection<RecoveryItem>("/recovery", {
    start,
    end,
    limit: "10",
  });
}

/** Cycles overlapping the given date. Most recent first. */
export async function getCycle(dateISO: string): Promise<CycleItem[]> {
  const { start, end } = dayRangeForLocalDate(dateISO);
  return fetchCollection<CycleItem>("/cycle", { start, end, limit: "10" });
}

/** Sleeps overlapping the given date. Most recent first. */
export async function getSleep(dateISO: string): Promise<SleepItem[]> {
  const { start, end } = dayRangeForLocalDate(dateISO);
  return fetchCollection<SleepItem>("/activity/sleep", {
    start,
    end,
    limit: "10",
  });
}

/** Workouts overlapping the given date. */
export async function getWorkouts(dateISO: string): Promise<WorkoutItem[]> {
  const { start, end } = dayRangeForLocalDate(dateISO);
  return fetchCollection<WorkoutItem>("/activity/workout", {
    start,
    end,
    limit: "25",
  });
}

/** Fetch a single sleep by ID (used by the webhook handler). */
export async function getSleepById(sleepId: string): Promise<SleepItem | null> {
  const res = await authedFetch(`/activity/sleep/${encodeURIComponent(sleepId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whoop sleep ${sleepId} ${res.status}: ${body}`);
  }
  return (await res.json()) as SleepItem;
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
    timeZone: USER_TIMEZONE,
  });
}

/** YYYY-MM-DD calendar date of the given instant in the user's TZ. */
function localDateOf(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: USER_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Build a single Whoop Daily row for `dateISO` (a YYYY-MM-DD calendar
 * day in the user's local TZ).
 *
 * Whoop's "cycle" runs bed-to-bed, not midnight-to-midnight, so we map:
 *   - cycle for day D = cycle whose end (next bedtime) falls on day D
 *   - sleep for day D = the non-nap sleep whose end (wake time) falls
 *     on day D
 *   - recovery for day D = the recovery whose cycle_id matches the
 *     chosen cycle (Whoop computes this once per cycle from that
 *     cycle's preceding sleep)
 * Strain ties are broken by max value (defensive — Whoop usually
 * returns one cycle per day in the picked window).
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

  // TEMP DIAGNOSTIC: log raw API responses so we can see what fields Whoop
  // is returning vs what the mapping below is reading. Remove once the
  // recovery/rhr/hrv blank-fields investigation closes.
  console.warn(
    `[whoop-sync] raw response: date=${dateISO} recoveries=${JSON.stringify(recoveries)}`
  );
  console.warn(
    `[whoop-sync] raw response: date=${dateISO} cycles=${JSON.stringify(cycles)}`
  );
  console.warn(
    `[whoop-sync] raw response: date=${dateISO} sleeps_count=${sleeps.length} sleep_score_states=${JSON.stringify(sleeps.map((s) => s.score_state))}`
  );

  // --- Cycle for day D ---
  // Only consider SCORED cycles. PENDING/UNSCORABLE items have no
  // score yet (Whoop is still aggregating); writing them produces
  // empty values that visually overwrite previously-good data on
  // re-run. We'd rather skip and let a later cron tick fill it in.
  const dayCycles = cycles.filter((c) => {
    if (c.score_state && c.score_state !== "SCORED") return false;
    const endDate = c.end ? localDateOf(new Date(c.end)) : null;
    if (endDate === dateISO) return true;
    // Don't match in-progress cycles (no end) — those are by
    // definition unscored and can't tell us yesterday's strain.
    return false;
  });
  const chosenCycle =
    dayCycles
      .slice()
      .sort((a, b) => (b.score?.strain ?? -1) - (a.score?.strain ?? -1))[0] ||
    undefined;
  const strain = chosenCycle?.score?.strain;

  // --- Recovery for that cycle (must also be SCORED) ---
  const recovery = chosenCycle
    ? recoveries.find(
        (r) =>
          r.cycle_id === chosenCycle.id &&
          (!r.score_state || r.score_state === "SCORED")
      )
    : undefined;
  const recoveryScore = recovery?.score?.recovery_score;
  const rhr = recovery?.score?.resting_heart_rate;
  const hrv = recovery?.score?.hrv_rmssd_milli;

  // --- Sleep for day D: non-nap sleep whose end is on day D in user TZ ---
  const validSleeps = sleeps.filter((s) => !s.nap && s.start && s.end);
  const dayEndedSleeps = validSleeps.filter(
    (s) => localDateOf(new Date(s.end)) === dateISO
  );
  const chosenSleep = (dayEndedSleeps.length ? dayEndedSleeps : validSleeps)
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
    const ms =
      new Date(chosenSleep.end).getTime() - new Date(chosenSleep.start).getTime();
    sleepHours = Math.round((ms / 3600000) * 10) / 10;
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
