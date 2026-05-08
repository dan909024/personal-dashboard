/**
 * /screentime — full screen-time breakdown for the last 7 days.
 *
 * This page is the click-through from the PHONE tile and doubles as
 * the diagnostic when numbers look wrong. Renders raw rows from the
 * "Screen Time" Sheet tab, grouped by date, with each row's source +
 * category + raw minutes value visible. Anything at the 1440-minute
 * server-side cap is badged so a single source sending bogus values
 * is obvious at a glance.
 *
 * Reads UNCACHED via getRecentScreentime so a fresh ingest is visible
 * immediately.
 */
import Link from "next/link";
import { getRecentScreentime, type ScreenTimeRow } from "@/lib/sheets";
import {
  displayAppName,
  fmtPhoneMinutes,
  SCREENTIME_CAP_MINUTES,
} from "@/lib/screentime-display";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DayGroup = {
  date: string;
  rows: ScreenTimeRow[];
  bySource: Record<string, number>;
  totalAllRows: number;
};

function groupByDay(rows: ScreenTimeRow[]): DayGroup[] {
  const map = new Map<string, ScreenTimeRow[]>();
  for (const r of rows) {
    const list = map.get(r.date) || [];
    list.push(r);
    map.set(r.date, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, dayRows]) => {
      const bySource: Record<string, number> = {};
      let totalAllRows = 0;
      for (const r of dayRows) {
        bySource[r.source] = (bySource[r.source] || 0) + r.minutes;
        totalAllRows += r.minutes;
      }
      // Sort rows: capped first (most suspicious), then by minutes desc
      const sorted = [...dayRows].sort((a, b) => {
        const aCap = a.minutes >= SCREENTIME_CAP_MINUTES ? 1 : 0;
        const bCap = b.minutes >= SCREENTIME_CAP_MINUTES ? 1 : 0;
        if (aCap !== bCap) return bCap - aCap;
        return b.minutes - a.minutes;
      });
      return { date, rows: sorted, bySource, totalAllRows };
    });
}

export default async function ScreentimePage() {
  const rows = await getRecentScreentime(7);
  const groups = groupByDay(rows);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-5">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-baseline justify-between mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            Screen Time — last 7 days
          </p>
          <Link
            href="/"
            className="text-xs text-zinc-400 hover:text-white transition-colors"
          >
            ← back to dashboard
          </Link>
        </div>

        <IphoneLauncher />


        {groups.length === 0 ? (
          <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
            <p className="text-sm text-zinc-400">No screen time data in the last 7 days.</p>
            <p className="text-xs text-zinc-500 mt-2">
              Sources: <code className="bg-black/30 px-1">ios_shortcut</code>{" "}
              (iPhone Personal Automation) and{" "}
              <code className="bg-black/30 px-1">mac_launchd</code> (Mac sync).
              See <code className="bg-black/30 px-1">SETUP-SCREENTIME.md</code>.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <DayCard key={g.date} group={g} />
            ))}
          </div>
        )}

        {/* Legend */}
        <div className="mt-8 text-[10px] text-zinc-500 leading-relaxed">
          <p className="mb-1">
            <span className="text-rose-400">⚠ capped</span> — value reached the
            1440-minute (24h) server-side cap; the source is sending a number
            larger than a day's worth of minutes, which is impossible. Most
            often this is the iOS Shortcut sending seconds where minutes were
            expected, or the Mac collector summing overlapping{" "}
            <code className="text-zinc-400">/app/usage</code> records.
          </p>
          <p>
            Rows are deduped per (date, source, app) on read — but per-source
            duplicates and category-vs-app double-counts are intentionally NOT
            collapsed here so you can see exactly what each source is sending.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * iPhone Screen Time launcher. The dashboard cannot read iPhone usage
 * data directly (Apple locks it behind the Family Controls entitlement),
 * so visibility lives outside this dashboard. This tile is a one-tap
 * jump to wherever the canonical iPhone view lives — Apple Family
 * Sharing if Harley uses Apple, or a paid SaaS web dashboard otherwise.
 *
 * Set IPHONE_SCREENTIME_URL in Vercel env once you've picked a tool.
 * The tile adapts copy based on whether the URL points to apple.com,
 * qustodio.com, or anything else.
 */
function IphoneLauncher() {
  const url = process.env.IPHONE_SCREENTIME_URL || "";
  if (!url) {
    return (
      <section className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4 mb-5">
        <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
          iPhone Screen Time
        </p>
        <p className="text-sm text-zinc-400">
          Not configured. Apple's Screen Time data isn't readable from this
          dashboard's server (Apple locks it behind the Family Controls
          entitlement), so iPhone visibility lives in an external tool.
        </p>
        <p className="text-[10px] text-zinc-500 uppercase tracking-widest mt-3">
          To wire up
        </p>
        <p className="text-xs text-zinc-400 mt-1">
          Set <code className="bg-black/30 px-1">IPHONE_SCREENTIME_URL</code>{" "}
          in Vercel env. Examples: Apple Family Sharing on iCloud Web, the
          Qustodio parent dashboard, OurPact, etc.
        </p>
      </section>
    );
  }
  let label = "iPhone Screen Time";
  let helper = "Open the canonical iPhone Screen Time view.";
  if (url.includes("apple.com") || url.includes("icloud.com")) {
    label = "iPhone Screen Time — Apple Family Sharing";
    helper = "Free, native, best privacy. Usage durations only.";
  } else if (url.includes("qustodio")) {
    label = "iPhone Screen Time — Qustodio";
    helper = "Web dashboard. Configure as time-tracking-only.";
  } else if (url.includes("ourpact")) {
    label = "iPhone Screen Time — OurPact";
    helper = "Web dashboard.";
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4 mb-5 hover:border-[#333] transition-colors"
    >
      <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2 flex items-center justify-between">
        {label}
        <span className="text-zinc-600 normal-case tracking-normal">open →</span>
      </p>
      <p className="text-xs text-zinc-500">{helper}</p>
    </a>
  );
}

function DayCard({ group }: { group: DayGroup }) {
  return (
    <section className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-sm font-semibold text-white">{group.date}</p>
        <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
          {Object.entries(group.bySource)
            .map(([s, m]) => `${s}: ${fmtPhoneMinutes(m)}`)
            .join(" · ")}
        </p>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] text-zinc-500 uppercase tracking-widest border-b border-[#222]">
            <th className="py-2 pr-2 font-normal">Source</th>
            <th className="py-2 pr-2 font-normal">Category</th>
            <th className="py-2 pr-2 font-normal">App</th>
            <th className="py-2 pr-2 font-normal text-right">Minutes</th>
            <th className="py-2 font-normal text-right">Display</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r, i) => {
            const capped = r.minutes >= SCREENTIME_CAP_MINUTES;
            const display = displayAppName(r.label);
            const sourceShort = r.source === "ios_shortcut" ? "iOS" : r.source === "mac_launchd" ? "Mac" : r.source;
            return (
              <tr
                key={`${r.source}-${r.label}-${i}`}
                className="border-b border-[#1a1a1a] last:border-b-0"
              >
                <td className="py-1.5 pr-2 text-zinc-400">{sourceShort}</td>
                <td className="py-1.5 pr-2 text-zinc-500">{r.category || "—"}</td>
                <td className="py-1.5 pr-2 text-zinc-200">
                  {display}
                  {display !== r.label && (
                    <span className="text-zinc-600 ml-1.5 font-mono text-[10px]">
                      ({r.label})
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-zinc-300">
                  {r.minutes}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  <span
                    className={
                      capped
                        ? "text-rose-400"
                        : r.minutes >= 60
                        ? "text-amber-300"
                        : "text-zinc-300"
                    }
                  >
                    {fmtPhoneMinutes(r.minutes)}
                    {capped && (
                      <span className="ml-1 text-[10px]">⚠ capped</span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
