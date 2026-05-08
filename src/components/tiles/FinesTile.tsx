/**
 * Three-section fines display:
 *   1. THIS WEEK (RUNNING) — live evaluator estimate over Mon-today
 *   2. LAST WEEK — finalized fines for the prior ISO week (read from
 *      Punishments rows whose Reason text contains the prior week id)
 *   3. TOTAL OWED — running ledger from getHarleyBalance
 *
 * Server component. Drop into the dashboard with:
 *   import { FinesTile } from "@/components/tiles/FinesTile";
 *   <FinesTile />
 */
import {
  getHarleyBalance,
  getPunishmentsMatching,
  getRuleChecks,
  isConfigured,
} from "@/lib/sheets";
import {
  daysOfWeek,
  evaluateWeek,
  isoWeekContaining,
  sydneyTodayISO,
  weekId as makeWeekId,
  type WeeklyOutcome,
} from "@/lib/rules";
import { buildWeekInput } from "@/lib/rules-data";

type LoadedData = {
  thisWeekId: string;
  thisWeekRange: { monday: string; sunday: string };
  thisWeekOutcomes: WeeklyOutcome[];
  thisWeekTotal: number;
  thisWeekDaysCovered: number;
  lastWeekId: string;
  lastWeekRange: { monday: string; sunday: string };
  lastWeekFines: { amount: number; reason: string; ruleId: string; paid: boolean }[];
  lastWeekTotal: number;
  totalOwed: number;
  totalFinesAllTime: number;
  totalPaidAllTime: number;
};

export async function FinesTile() {
  if (!isConfigured()) {
    return (
      <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
        <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Fines</p>
        <p className="text-xs text-zinc-500 italic mt-2">unconfigured</p>
      </div>
    );
  }

  const data = await loadData();

  return (
    <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
        <Section
          title="This week (running)"
          subtitle={`${data.thisWeekId} · ${data.thisWeekDaysCovered}/7 days`}
          amount={data.thisWeekTotal}
          amountColor="text-amber-300"
        >
          {data.thisWeekOutcomes.length === 0 ? (
            <p className="text-xs text-zinc-500 italic">no active rules</p>
          ) : (
            <ul className="space-y-1">
              {data.thisWeekOutcomes.map((o) => (
                <li key={o.ruleId} className="flex items-start gap-2 text-xs">
                  <span
                    className={`w-1.5 h-1.5 mt-1.5 rounded-full shrink-0 ${
                      o.fineAmount > 0 ? "bg-amber-400" : "bg-emerald-500"
                    }`}
                  />
                  <span className="flex-1 text-zinc-300">
                    <span className="text-zinc-200">{o.ruleId}</span>{" "}
                    <span className="text-zinc-500">· {o.summary}</span>
                  </span>
                  {o.fineAmount > 0 && (
                    <span className="text-amber-300 tabular-nums shrink-0">${o.fineAmount}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Last week"
          subtitle={`${data.lastWeekId} · ${data.lastWeekRange.monday}…${data.lastWeekRange.sunday}`}
          amount={data.lastWeekTotal}
          amountColor={data.lastWeekTotal > 0 ? "text-red-400" : "text-emerald-400"}
          borderLeft
        >
          {data.lastWeekFines.length === 0 ? (
            <p className="text-xs text-zinc-500 italic">no fines logged</p>
          ) : (
            <ul className="space-y-1">
              {data.lastWeekFines.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span
                    className={`w-1.5 h-1.5 mt-1.5 rounded-full shrink-0 ${
                      f.paid ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <span className="flex-1 text-zinc-300">
                    <span className="text-zinc-200">{f.ruleId}</span>
                    {f.paid && <span className="text-emerald-400 ml-1">(paid)</span>}
                  </span>
                  <span className="text-red-400 tabular-nums shrink-0">${f.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Total owed"
          subtitle={`fines $${data.totalFinesAllTime.toLocaleString("en-AU")} · paid $${data.totalPaidAllTime.toLocaleString("en-AU")}`}
          amount={data.totalOwed}
          amountColor={data.totalOwed > 0 ? "text-red-400" : "text-emerald-400"}
          large
          borderLeft
        >
          <p className="text-[10px] text-zinc-600 uppercase tracking-widest">
            Running ledger across all unpaid Punishments
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  amount,
  amountColor,
  large,
  borderLeft,
  children,
}: {
  title: string;
  subtitle?: string;
  amount: number;
  amountColor: string;
  large?: boolean;
  borderLeft?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`p-4 ${borderLeft ? "border-t md:border-t-0 md:border-l border-[#222]" : ""}`}>
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">{title}</p>
      </div>
      {subtitle && (
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest mb-2">{subtitle}</p>
      )}
      <p className={`${large ? "text-4xl" : "text-3xl"} font-bold tabular-nums mb-3 ${amountColor}`}>
        ${amount.toLocaleString("en-AU")}
      </p>
      {children}
    </div>
  );
}

async function loadData(): Promise<LoadedData> {
  const today = sydneyTodayISO();
  const thisWeek = isoWeekContaining(today);
  const yesterdayMs = Date.parse(today + "T12:00:00Z") - 86400 * 1000;
  const yesterday = new Date(yesterdayMs).toISOString().slice(0, 10);
  // "Last week" = the week BEFORE the current. If today is in the current
  // running week, this reads the most recently completed week.
  const lastWeekAnchor = new Date(
    Date.parse(thisWeek.monday + "T12:00:00Z") - 86400 * 1000
  )
    .toISOString()
    .slice(0, 10);
  const lastWeek = isoWeekContaining(lastWeekAnchor);

  const thisWeekId = makeWeekId(thisWeek.year, thisWeek.week);
  const lastWeekId = makeWeekId(lastWeek.year, lastWeek.week);

  // Days for the current-week running estimate: Mon → today inclusive.
  const allDaysThisWeek = daysOfWeek(thisWeek.monday);
  const daysSoFar = allDaysThisWeek.filter((d) => d <= today);
  // If today is Mon and Whoop hasn't synced yet, daysSoFar = [today] —
  // running estimate is just one day. That's fine.
  // Note: "yesterday" reference kept for future hooks (e.g. excluding today
  // until Whoop syncs); not used directly here.
  void yesterday;

  const [rules, balance, lastWeekRows] = await Promise.all([
    getRuleChecks(),
    getHarleyBalance(),
    getPunishmentsMatching(`(${lastWeekId})`),
  ]);

  const activeRules = rules.filter((r) => r.active);

  let thisWeekOutcomes: WeeklyOutcome[] = [];
  let thisWeekTotal = 0;
  if (activeRules.length > 0 && daysSoFar.length > 0) {
    const input = await buildWeekInput({ weekId: thisWeekId, days: daysSoFar });
    thisWeekOutcomes = evaluateWeek(activeRules, input);
    thisWeekTotal = thisWeekOutcomes.reduce((s, o) => s + o.fineAmount, 0);
  }

  const lastWeekFines = lastWeekRows
    .map((r) => ({
      amount: r.amount,
      reason: r.reason,
      ruleId: extractRuleId(r.reason),
      paid: r.paid,
    }))
    .sort((a, b) => b.amount - a.amount);
  const lastWeekTotal = lastWeekFines.reduce((s, f) => s + f.amount, 0);

  return {
    thisWeekId,
    thisWeekRange: { monday: thisWeek.monday, sunday: thisWeek.sunday },
    thisWeekOutcomes,
    thisWeekTotal,
    thisWeekDaysCovered: daysSoFar.length,
    lastWeekId,
    lastWeekRange: { monday: lastWeek.monday, sunday: lastWeek.sunday },
    lastWeekFines,
    lastWeekTotal,
    totalOwed: balance.owed,
    totalFinesAllTime: balance.finesTotal,
    totalPaidAllTime: balance.paidTotal,
  };
}

function extractRuleId(reason: string): string {
  const m = reason.match(/^\[rule:([^\]]+)\]/);
  return m ? m[1] : reason.slice(0, 24);
}
