/**
 * Harley calendar tile — surfaces Harley-authored events from the
 * shared `weekly` Google Calendar. Reads via getHarleyTaskWindow() —
 * the same source the Harley Meter consumes — so the tile and the
 * meter % can never disagree.
 *
 * Visual: branded as a country-club coach's day-card. Cobalt-ringed
 * date chips against an iron-and-ivory frame with a rose accent for
 * the "Harley says" voice.
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

/** Tiny rose-monogram instead of the Google G — keeps the "card from
 *  Harley" feel without lifting another product's brand. */
function RoseMonogram({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="3"
        width="42"
        height="42"
        rx="6"
        fill="var(--color-iron-700)"
        stroke="var(--color-bloom)"
        strokeWidth="1.5"
      />
      {/* Stylised rose — concentric petal arcs */}
      <circle cx="24" cy="25" r="11" fill="none" stroke="var(--color-bloom)" strokeWidth="1.4" />
      <circle cx="24" cy="25" r="7" fill="none" stroke="var(--color-bloom-300)" strokeWidth="1.4" />
      <circle cx="24" cy="25" r="3" fill="var(--color-bloom-300)" />
      {/* Two tabs that read as a calendar */}
      <rect x="14" y="2" width="3" height="7" rx="1.5" fill="var(--color-bloom)" />
      <rect x="31" y="2" width="3" height="7" rx="1.5" fill="var(--color-bloom)" />
    </svg>
  );
}

function DateChip({ iso, tone }: { iso: string; tone: "future" | "past" }) {
  const { day, weekday } = fmtDayWeekday(iso);
  const future = tone === "future";
  return (
    <div
      className="flex flex-col items-center justify-center w-12 h-12 shrink-0 rounded border text-center"
      style={{
        borderColor: future ? "var(--color-coach)" : "var(--color-iron-50)",
        background: future
          ? "rgba(31, 95, 199, 0.10)"
          : "rgba(243, 231, 204, 0.04)",
      }}
    >
      <span
        className="text-[9px] font-bold tracking-widest uppercase leading-none"
        style={{
          color: future ? "var(--color-coach-300)" : "var(--color-ivory-400)",
        }}
      >
        {weekday}
      </span>
      <span
        className={`brand-serif text-lg font-semibold leading-none mt-1 ${
          future ? "text-ivory" : "text-ivory-400/60"
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
      className="tile-card p-5 rounded"
      style={{
        borderColor: "var(--color-coach-700)",
        boxShadow:
          "inset 0 1px 0 0 rgba(243,231,204,0.06), 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px -8px rgba(0,0,0,0.55), 0 24px 64px -16px rgba(31,95,199,0.22)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <RoseMonogram size={36} />
          <div>
            <p className="brand-serif text-base font-semibold tracking-tight text-ivory leading-tight">
              Harley&rsquo;s Calendar
            </p>
            <p className="text-[10px] tracking-[0.22em] text-ivory-400/70 uppercase">
              from the shared weekly
            </p>
          </div>
        </div>
        <a
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-3 py-2 text-xs font-bold tracking-[0.18em] uppercase rounded transition-colors text-ivory hover:bg-coach-600"
          style={{
            background: "var(--color-coach)",
          }}
        >
          <span aria-hidden="true">↗</span>
          Open calendar
        </a>
      </div>

      {/* Body */}
      {!configured ? (
        <p className="text-xs text-ivory-400/70">
          Calendar not configured. Set <code>GOOGLE_CALENDAR_ID</code> and{" "}
          <code>DASHBOARD_OWNER_EMAIL</code>.
        </p>
      ) : !hasEvents ? (
        <div className="flex items-center gap-3 py-4">
          <div
            className="w-1 h-12 rounded"
            style={{ background: "var(--color-coach)" }}
          />
          <div>
            <p className="text-sm text-ivory-100/80">
              No tasks from Harley yet.
            </p>
            <p className="text-xs text-ivory-400/70 mt-1">
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
                  style={{ background: "var(--color-coach)" }}
                />
                <p
                  className="brand-serif text-[11px] tracking-[0.22em] uppercase font-semibold"
                  style={{ color: "var(--color-coach-300)" }}
                >
                  Upcoming
                </p>
              </div>
              <ul className="space-y-2">
                {upcoming.map((ev) => (
                  <li key={ev.eventId} className="flex items-center gap-3">
                    <DateChip iso={ev.startISO} tone="future" />
                    <div className="min-w-0">
                      <p className="text-sm text-ivory truncate">
                        {ev.summary}
                      </p>
                      <p className="text-xs text-ivory-400/70">
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
                <span className="w-2 h-2 rounded-full bg-iron-50" />
                <p className="brand-serif text-[11px] tracking-[0.22em] uppercase font-semibold text-ivory-400/70">
                  Recent (done)
                </p>
              </div>
              <ul className="space-y-2">
                {recentPast.map((ev) => (
                  <li key={ev.eventId} className="flex items-center gap-3 opacity-70">
                    <DateChip iso={ev.startISO} tone="past" />
                    <div className="min-w-0">
                      <p className="text-sm text-ivory-300/80 truncate line-through decoration-iron-50">
                        {ev.summary}
                      </p>
                      <p className="text-xs text-ivory-400/50">
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

      {/* Footer brand stripe — coach + bloom + sage + ivory */}
      <div className="flex h-1 mt-4 rounded overflow-hidden">
        <div className="flex-1" style={{ background: "var(--color-coach)" }} />
        <div className="flex-1" style={{ background: "var(--color-bloom)" }} />
        <div className="flex-1" style={{ background: "var(--color-sage)" }} />
        <div className="flex-1" style={{ background: "var(--color-ivory)" }} />
      </div>
    </div>
  );
}
