/**
 * /transactions — full Amex transaction breakdown for the last 30 days.
 *
 * Click-through from the TRANSACTIONS tile. Shows charges grouped by date
 * with merchant, amount, card last-4, plus the latest balance row from
 * weekly Amex summary emails. Reads UNCACHED so a fresh inbound POST
 * shows up immediately.
 */
import Link from "next/link";
import {
  getRecentAmexTransactions,
  type AmexTransactionRow,
} from "@/lib/sheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DayGroup = {
  date: string;
  charges: AmexTransactionRow[];
  total: number;
};

function fmtAmount(n: number, currency = "AUD"): string {
  if (!Number.isFinite(n)) return "—";
  const symbol = currency === "USD" ? "US$" : "$";
  return `${symbol}${n.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(iso: string): string {
  const t = Date.parse(iso + "T12:00:00Z");
  if (isNaN(t)) return iso;
  return new Date(t).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

function groupChargesByDate(rows: AmexTransactionRow[]): DayGroup[] {
  const map = new Map<string, AmexTransactionRow[]>();
  for (const r of rows) {
    const list = map.get(r.date) || [];
    list.push(r);
    map.set(r.date, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, dayRows]) => ({
      date,
      charges: dayRows,
      total: dayRows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0),
    }));
}

export default async function TransactionsPage() {
  // Pull both — charges drive the day list, balance + unparsed surface as diagnostics.
  const all = await getRecentAmexTransactions(30, {
    includeBalance: true,
    includeUnparsed: true,
  });
  const charges = all.filter((r) => r.type === "charge");
  const balances = all
    .filter((r) => r.type === "balance")
    .sort((a, b) => (a.syncedAt < b.syncedAt ? 1 : -1));
  const unparsed = all.filter((r) => r.type === "unparsed");

  const groups = groupChargesByDate(charges);
  const totalAll = charges.reduce(
    (s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0),
    0
  );
  const latestBalance = balances[0];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-5">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-baseline justify-between mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            Transactions — last 30 days
          </p>
          <Link
            href="/"
            className="text-xs text-zinc-400 hover:text-white transition-colors"
          >
            ← back to dashboard
          </Link>
        </div>

        {/* Summary strip */}
        <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4 mb-5">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <SummaryStat label="30d spend" value={fmtAmount(totalAll)} />
            <SummaryStat
              label="Charges"
              value={`${charges.length}`}
              sub={
                charges.length > 0
                  ? `across ${groups.length} day${groups.length === 1 ? "" : "s"}`
                  : undefined
              }
            />
            {latestBalance ? (
              <SummaryStat
                label="Latest balance"
                value={fmtAmount(latestBalance.amount, latestBalance.currency)}
                sub={`as of ${fmtDate(latestBalance.date)}`}
              />
            ) : null}
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
            <p className="text-sm text-zinc-400">
              No charges in the last 30 days.
            </p>
            <p className="text-xs text-zinc-500 mt-2">
              Inbound webhook lives at{" "}
              <code className="bg-black/30 px-1">/api/amex/inbound</code>. If
              you expect data, check that Gmail is forwarding to CloudMailin
              and that <code className="bg-black/30 px-1">AMEX_INGEST_SECRET</code>{" "}
              matches.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <DayCard key={g.date} group={g} />
            ))}
          </div>
        )}

        {unparsed.length > 0 ? (
          <div className="mt-6 border border-amber-900 bg-amber-950/30 backdrop-blur-sm p-4">
            <p className="text-[10px] font-bold tracking-widest text-amber-300 uppercase mb-2">
              Unparsed {unparsed.length}
            </p>
            <p className="text-xs text-amber-200/80 mb-3">
              These rows landed but the parser couldn&apos;t extract structured
              fields. The full subject is preserved so you can sample one and
              tighten <code className="bg-black/30 px-1">parseAmexEmail</code>.
            </p>
            <div className="space-y-1.5">
              {unparsed.slice(0, 10).map((r) => (
                <div
                  key={r.emailId}
                  className="text-xs text-amber-100/90 flex items-baseline gap-2"
                >
                  <span className="text-zinc-500 shrink-0 tabular-nums">
                    {fmtDate(r.date)}
                  </span>
                  <span className="truncate">{r.subject || "(no subject)"}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
        {label}
      </p>
      <p className="text-2xl font-bold text-white">{value}</p>
      {sub ? <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p> : null}
    </div>
  );
}

function DayCard({ group }: { group: DayGroup }) {
  return (
    <section className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
          {fmtDate(group.date)}
        </p>
        <p className="text-sm text-zinc-300 font-mono">{fmtAmount(group.total)}</p>
      </div>
      <div className="space-y-1.5">
        {group.charges.map((c) => (
          <div
            key={c.emailId}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="truncate text-zinc-200">
              {c.merchant || "(unknown merchant)"}
            </span>
            <span className="flex items-baseline gap-2 shrink-0">
              {c.cardLast4 ? (
                <span className="text-[10px] text-zinc-500 font-mono">
                  ····{c.cardLast4}
                </span>
              ) : null}
              <span className="text-zinc-100 font-mono tabular-nums">
                {fmtAmount(c.amount, c.currency)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
