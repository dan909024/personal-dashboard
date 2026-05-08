/**
 * Google Calendar reader. Fetches events from a shared calendar
 * (Daniel + Harley both have access), segregates by event creator
 * email, and exposes the Harley-authored slice as the "task" stream.
 *
 * Auth: same service account JSON as sheets — read GOOGLE_SERVICE_ACCOUNT_JSON.
 *   Daniel shares his personal Gmail calendar with the service account
 *   (read-only). Service accounts cannot use "primary"; the calendar
 *   ID must be the full email address.
 *
 * Env:
 *   GOOGLE_CALENDAR_ID    — full address of the shared calendar
 *   DASHBOARD_OWNER_EMAIL — Daniel's email; anything in event.creator.email
 *                           that doesn't match this is "Harley-authored".
 */
import { google, calendar_v3 } from "googleapis";
import { loadServiceAccountCreds } from "./sheets";

const PAST_DAYS = 30;
const FUTURE_DAYS = 7;

export type CalendarTask = {
  eventId: string;
  etag: string;
  summary: string;
  startISO: string;
  isPast: boolean;
};

export type HarleyTaskWindow = {
  past: CalendarTask[];
  future: CalendarTask[];
};

let cachedClient: calendar_v3.Calendar | null = null;

export function isCalendarConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
      process.env.GOOGLE_CALENDAR_ID &&
      process.env.DASHBOARD_OWNER_EMAIL
  );
}

function calendarClient(): calendar_v3.Calendar {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.GoogleAuth({
    credentials: loadServiceAccountCreds(),
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
  cachedClient = google.calendar({ version: "v3", auth });
  return cachedClient;
}

function eventStartISO(ev: calendar_v3.Schema$Event): string {
  return (
    ev.start?.dateTime ||
    ev.start?.date ||
    ""
  );
}

function isHarleyAuthored(
  ev: calendar_v3.Schema$Event,
  ownerEmail: string
): boolean {
  const creator = (ev.creator?.email || "").toLowerCase();
  if (!creator) return false;
  return creator !== ownerEmail.toLowerCase();
}

/**
 * Fetch the rolling task window from the shared calendar.
 * Returns Harley-authored events split into past (<= now) and future.
 */
export async function getHarleyTaskWindow(): Promise<HarleyTaskWindow> {
  if (!isCalendarConfigured()) {
    return { past: [], future: [] };
  }
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "";
  const ownerEmail = process.env.DASHBOARD_OWNER_EMAIL || "";
  const cal = calendarClient();

  const now = new Date();
  const timeMin = new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + FUTURE_DAYS * 86_400_000).toISOString();

  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
    });
    if (res.data.items) events.push(...res.data.items);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  const past: CalendarTask[] = [];
  const future: CalendarTask[] = [];
  const nowMs = now.getTime();

  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    if (!isHarleyAuthored(ev, ownerEmail)) continue;
    const startISO = eventStartISO(ev);
    if (!startISO) continue;
    const startMs = new Date(startISO).getTime();
    if (!Number.isFinite(startMs)) continue;
    const task: CalendarTask = {
      eventId: ev.id || "",
      etag: ev.etag || "",
      summary: ev.summary || "(no title)",
      startISO,
      isPast: startMs <= nowMs,
    };
    if (!task.eventId) continue;
    (task.isPast ? past : future).push(task);
  }

  return { past, future };
}
