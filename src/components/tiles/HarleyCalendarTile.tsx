/**
 * Harley calendar tile — surfaces Harley-authored events from the
 * shared `weekly` Google Calendar. Reads via getHarleyTaskWindow() —
 * the same source the Harley Meter consumes — so the tile and the
 * meter % can never disagree.
 *
 * Visual: Google Calendar branding cues (logo SVG, brand-blue accent
 * border, "Open in Google Calendar" pill button). Each event renders
 * with a colored date chip evoking the Calendar app's day cells.
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

const GOOGLE_BLUE = "#4285F4";
const GOOGLE_RED = "#EA4335";
const GOOGLE_YELLOW = "#FBBC04";
const GOOGLE_GREEN = "#34A853";

function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function fmtDayWeekday(iso: string): { day: string; weekday: string } {
  if (!iso) return { day: "", weekday: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "", weekday: "" };
  const day = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TZ,
    day: "numeric",
  }).format(d);
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TZ,
    weekday: "short",
  }).format(d);
  return { day, weekday };
}

function calendarOpenUrl(calendarId: string | undefined): string {
  if (!calendarId) return "https://calendar.google.com/calendar/u/0/r";
  const b64 = Buffer.from(calendarId).toString("base64").replace(/=+$/, "");
  return `https://calendar.google.com/calendar/u/0?cid=${b64}`;
}

/** Faithful-ish Google Calendar app icon — rounded square with the
 *  red top bar and a "31" centered. Uses Google's brand palette so it
 *  reads as the real product without lifting the actual logo. */
function GoogleCalendarLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="40" height="40" rx="6" fill="#fff" />
      <path d="M4 10a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v4H4z" fill={GOOGLE_RED} />
      <text
        x="24"
        y="34"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontWeight="700"
        fontSize="18"
        fill={GOOGLE_BLUE}
      >
        31
      </text>
      {/* The two top tabs that make it read as a calendar */}
      <rect x="14" y="2" width="3" height="8" rx="1.5" fill={GOOGLE_RED} />
      <rect x="31" y="2" width="3" height="8" rx="1.5" fill={GOOGLE_RED} />
    </svg>
  );
}

function DateChip({ iso, tone }: { iso: string; tone: "future" | "past" }) {
  const { day, weekday } = fmtDayWeekday(iso);
  const accent =
    tone === "future"
      ? { ring: GOOGLE_BLUE, dim: "rgba(66,133,244,0.12)" }
      : { ring: "#444", dim: "rgba(255,255,255,0.04)" };
  return (
    <div
      className="flex flex-col items-center justify-center w-12 h-12 shrink-0 rounded border text-center"
      style={{ borderColor: accent.ring, background: accent.dim }}
    >
      <span
        className="text-[9px] font-bold tracking-widest uppercase leading-none"
        style={{ color: tone === "future" ? GOOGLE_BLUE : "#888" }}
      >
        {weekday}
      </span>
      <span
        className={`text-lg font-bold leading-none mt-1 ${
          tone === "future" ? "text-white" : "text-zinc-500"
        }`}
      >
        {day}
      </span>
    </div>
  );
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

  const hasEvents = upcoming.length > 0 || recentPast.length > 0;

  return (
    <div
      className="border bg-[#0f0f0f]/85 backdrop-blur-sm p-5 rounded"
      style={{
        borderColor: GOOGLE_BLUE,
        boxShadow: `0 0 24px -10px ${GOOGLE_BLUE}`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <GoogleCalendarLogo size={36} />
          <div>
            <p className="text-sm font-bold tracking-wide text-white uppercase leading-tight">
              Harley&rsquo;s Calendar
            </p>
            <p className="text-[10px] tracking-widest text-zinc-500 uppercase">
              from Google Calendar
            </p>
          </div>
        </div>
        <a
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-3 py-2 text-xs font-bold tracking-wide uppercase rounded transition-colors"
          style={{
            background: GOOGLE_BLUE,
            color: "#fff",
          }}
        >
          <span aria-hidden="true">↗</span>
          Open in Google Calendar
        </a>
      </div>

      {/* Body */}
      {!configured ? (
        <p className="text-xs text-zinc-500">
          Calendar not configured. Set <code>GOOGLE_CALENDAR_ID</code> and{" "}
          <code>DASHBOARD_OWNER_EMAIL</code>.
        </p>
      ) : !hasEvents ? (
        <div className="flex items-center gap-3 py-4">
          <div
            className="w-1 h-12 rounded"
            style={{ background: GOOGLE_BLUE }}
          />
          <div>
            <p className="text-sm text-zinc-300">
              No tasks from Harley yet.
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              When she adds an event to <strong>weekly</strong>, you&rsquo;ll get
              a Telegram and it&rsquo;ll show here within 5 minutes.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {upcoming.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: GOOGLE_BLUE }}
                />
                <p className="text-[10px] tracking-widest uppercase font-bold"
                  style={{ color: GOOGLE_BLUE }}>
                  Upcoming
                </p>
              </div>
              <ul className="space-y-2">
                {upcoming.map((ev) => (
                  <li key={ev.eventId} className="flex items-center gap-3">
                    <DateChip iso={ev.startISO} tone="future" />
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">
                        {ev.summary}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {fmtTime(ev.startISO)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recentPast.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-zinc-600" />
                <p className="text-[10px] tracking-widest uppercase font-bold text-zinc-500">
                  Recent (done)
                </p>
              </div>
              <ul className="space-y-2">
                {recentPast.map((ev) => (
                  <li key={ev.eventId} className="flex items-center gap-3 opacity-70">
                    <DateChip iso={ev.startISO} tone="past" />
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-400 truncate line-through decoration-zinc-700">
                        {ev.summary}
                      </p>
                      <p className="text-xs text-zinc-600">
                        {fmtTime(ev.startISO)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Footer rainbow accent — Google brand stripe */}
      <div className="flex h-1 mt-4 rounded overflow-hidden">
        <div className="flex-1" style={{ background: GOOGLE_BLUE }} />
        <div className="flex-1" style={{ background: GOOGLE_RED }} />
        <div className="flex-1" style={{ background: GOOGLE_YELLOW }} />
        <div className="flex-1" style={{ background: GOOGLE_GREEN }} />
      </div>
    </div>
  );
}
