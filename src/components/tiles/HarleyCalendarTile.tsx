/**
 * Renders the upcoming + recent Harley-authored events on the shared
 * `weekly` calendar. Reads via getHarleyTaskWindow() — same source the
 * Harley Meter consumes.
 *
 * Click-out: header "Open →" link goes to Google Calendar with the
 * shared calendar pre-selected (cid= base64 of the calendar id).
 */
import type { CalendarTask } from "@/lib/calendar";

type Props = {
  past: CalendarTask[];
  future: CalendarTask[];
  configured: boolean;
};

const SYDNEY_TZ = "Australia/Sydney";
const MAX_PAST = 5;
const MAX_FUTURE = 5;

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function calendarOpenUrl(calendarId: string | undefined): string {
  if (!calendarId) return "https://calendar.google.com/calendar/u/0/r";
  // Google's `cid=` URLs use base64 of the calendar id (no padding).
  const b64 = Buffer.from(calendarId).toString("base64").replace(/=+$/, "");
  return `https://calendar.google.com/calendar/u/0?cid=${b64}`;
}

export function HarleyCalendarTile({ past, future, configured }: Props) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const openHref = calendarOpenUrl(calendarId);

  const recentPast = [...past]
    .sort((a, b) => (a.startISO < b.startISO ? 1 : -1))
    .slice(0, MAX_PAST);
  const upcoming = [...future]
    .sort((a, b) => (a.startISO < b.startISO ? -1 : 1))
    .slice(0, MAX_FUTURE);

  return (
    <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
          HARLEY CALENDAR
        </p>
        <a
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-bold tracking-widest text-zinc-500 hover:text-zinc-300 uppercase"
        >
          Open →
        </a>
      </div>

      {!configured ? (
        <p className="text-xs text-zinc-500">Calendar not configured.</p>
      ) : upcoming.length === 0 && recentPast.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No Harley-authored events in the rolling window.
        </p>
      ) : (
        <div className="space-y-3">
          {upcoming.length > 0 && (
            <div>
              <p className="text-[10px] tracking-widest text-zinc-600 uppercase mb-1">
                Upcoming
              </p>
              <ul className="space-y-1">
                {upcoming.map((ev) => (
                  <li key={ev.eventId} className="text-sm text-white">
                    <span className="text-zinc-500 text-xs mr-2">
                      {fmtWhen(ev.startISO)}
                    </span>
                    {ev.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recentPast.length > 0 && (
            <div>
              <p className="text-[10px] tracking-widest text-zinc-600 uppercase mb-1">
                Recent (done)
              </p>
              <ul className="space-y-1">
                {recentPast.map((ev) => (
                  <li key={ev.eventId} className="text-sm text-zinc-400">
                    <span className="text-zinc-600 text-xs mr-2">
                      {fmtWhen(ev.startISO)}
                    </span>
                    <span className="line-through decoration-zinc-700">
                      {ev.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
