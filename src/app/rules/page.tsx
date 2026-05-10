/**
 * /rules — single source of truth listing of every rule the dashboard
 * is currently enforcing. Reads thresholds directly from
 * src/lib/harley-meter.ts so what's shown here matches what the meter
 * scores against (no drift between docs and reality).
 */
import Link from "next/link";
import {
  WAKE_BY_MIN,
  BED_BY_MIN,
  GYM_TARGET_PER_WEEK,
  STEPS_TARGET_PER_WEEK,
  WATER_TARGET_ML_PER_DAY,
  WINDOW_DAYS,
} from "@/lib/harley-meter";

export const revalidate = 60;

function fmtClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

type Rule = {
  id: string;
  title: string;
  threshold: string;
  source: string;
  weight: string;
  notes?: string;
};

const HARLEY_METER_RULES: Rule[] = [
  {
    id: "wake",
    title: "Wake by 06:00",
    threshold: `≤ ${fmtClock(WAKE_BY_MIN)} (Sydney)`,
    source: "Whoop sleep onset",
    weight: "1/5",
    notes: "Scored as fraction of days met across the rolling 7-day window.",
  },
  {
    id: "bed",
    title: "Bed by 22:30",
    threshold: `≤ ${fmtClock(BED_BY_MIN)} (Sydney)`,
    source: "Whoop sleep start",
    weight: "1/5",
    notes: "Onset between 00:00–05:59 counts as the next day for comparison.",
  },
  {
    id: "gym",
    title: "Gym sessions",
    threshold: `${GYM_TARGET_PER_WEEK}+ workouts / 7 days`,
    source: "Whoop Workouts",
    weight: "1/5",
    notes: "Apple Health workouts intentionally not counted — Whoop is the source of truth.",
  },
  {
    id: "steps",
    title: "Daily step floor",
    threshold: `10,000 steps / day (any day under counts as a missed day)`,
    source: "Apple Health (Auto Export)",
    weight: "1/5",
    notes: "Meter scores fraction of weekly target hit. Fine fires weekly: $10 × number of days under 10k.",
  },
  {
    id: "water",
    title: "Water intake",
    threshold: `${(WATER_TARGET_ML_PER_DAY / 1000).toFixed(1)} L / day average`,
    source: "Apple Health · dietaryWater (Ladder writes here)",
    weight: "1/5",
  },
];

export default function RulesPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-wide">Rules</h1>
          <Link
            href="/"
            className="text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-300"
          >
            ← Back to dashboard
          </Link>
        </div>

        <p className="text-zinc-400 text-sm mb-10 leading-relaxed">
          Every metric the dashboard scores against, in one place. Numbers come
          straight from <code className="bg-black/40 px-1">src/lib/harley-meter.ts</code> —
          if the constant changes, this page updates automatically.
        </p>

        {/* Harley Meter rules */}
        <section className="mb-12">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-xl font-bold tracking-wide">Harley Meter</h2>
            <p className="text-xs uppercase tracking-widest text-zinc-500">
              Rolling {WINDOW_DAYS}-day window · equally weighted
            </p>
          </div>
          <p className="text-zinc-400 text-sm mb-6">
            Each input contributes 0–1 to the meter; the score is their average × 100.
            Fail an input and the meter drops by ~17 percentage points for the
            week it stays missed.
          </p>

          <div className="border border-[#222] rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-black/40 text-left text-zinc-500 uppercase text-[10px] tracking-widest">
                  <th className="px-4 py-3">Rule</th>
                  <th className="px-4 py-3">Threshold</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">Weight</th>
                </tr>
              </thead>
              <tbody>
                {HARLEY_METER_RULES.map((r, i) => (
                  <tr
                    key={r.id}
                    className={
                      i % 2 === 0 ? "bg-[#0f0f0f]/60" : "bg-[#0a0a0a]/60"
                    }
                  >
                    <td className="px-4 py-3 align-top">
                      <p className="font-semibold text-white">{r.title}</p>
                      {r.notes && (
                        <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                          {r.notes}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-zinc-300">
                      {r.threshold}
                    </td>
                    <td className="px-4 py-3 align-top text-zinc-400">
                      {r.source}
                    </td>
                    <td className="px-4 py-3 align-top text-right text-zinc-300 tabular-nums">
                      {r.weight}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Fines */}
        <section className="mb-12">
          <h2 className="text-xl font-bold tracking-wide mb-4">Fines</h2>
          <p className="text-zinc-400 text-sm mb-6">
            Owed Harley balance. Sourced from two places:
          </p>
          <ul className="space-y-3 text-sm">
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Punishments tab (Sheet)</p>
              <p className="text-zinc-400 mt-1">
                Per-incident fines. Each row:{" "}
                <code className="bg-black/40 px-1">date / amount / reason / set by / paid? / rule</code>.
                Unpaid rows accumulate into the OWED HARLEY tile. The OWED HARLEY
                tooltip uses <strong>rule</strong> (a HarleyRuleId from{" "}
                <code className="bg-black/40 px-1">src/lib/harley-rules.ts</code>) to show
                provenance — empty rule = manual fine.
              </p>
            </li>
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Drinking · <code className="bg-black/40 px-1">drinking</code> rule</p>
              <p className="text-zinc-400 mt-1">
                Manual-only — no auto-eval. Two ways to log a drink, both stamp
                rule_id=drinking and respect hard-mode 2×:
              </p>
              <ul className="text-zinc-400 mt-2 ml-4 list-disc space-y-1">
                <li>
                  Goddess panel <strong>&ldquo;🍷 Daniel drank&rdquo;</strong> button.
                </li>
                <li>
                  Telegram <code className="bg-black/40 px-1">/drank</code> from
                  Daniel&rsquo;s DM. Same effect; replies with the dollar amount added.
                </li>
              </ul>
              <p className="text-zinc-500 mt-2 text-xs">
                Default $100/event; editable from the Goddess panel&rsquo;s Fine schedule.
                Spreadsheet calls for $100 per offence given a 0.25 drinks/week budget —
                a single drink is the offence.
              </p>
            </li>
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Telegram <code className="bg-black/40 px-1">/fine</code> command</p>
              <p className="text-zinc-400 mt-1">
                Harley DMs <code className="bg-black/40 px-1">/fine 45 phone over 90min</code>{" "}
                to the bot. The webhook appends a Punishments row with{" "}
                <em>set by</em> = sender&rsquo;s name + &ldquo;(Telegram)&rdquo; and empty rule.
                Restricted to authorized chat IDs (HARLEY_TELEGRAM_CHAT_ID,
                DAN_TELEGRAM_CHAT_ID, or TRIPWIRE fallback).
              </p>
            </li>
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Monthly fine</p>
              <p className="text-zinc-400 mt-1">
                Automatic <strong>$1,000</strong> appended on the 1st of each month by{" "}
                <code className="bg-black/40 px-1">/api/cron/monthly-fine</code>.
                Idempotent — re-running the cron the same month is a no-op. Empty rule.
              </p>
            </li>
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Auto rule-eval cron</p>
              <p className="text-zinc-400 mt-1">
                Daily at 22:00 Sydney via{" "}
                <code className="bg-black/40 px-1">/api/cron/rule-eval</code>.
                Reads Harley Meter inputs, appends Punishments rows for failed
                periods. Idempotent on (rule_id, period_start) — same period
                never fined twice. Per-rule amounts in{" "}
                <code className="bg-black/40 px-1">src/lib/rule-eval.ts</code>:
              </p>
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-400">
                <li>wake — $10 / failed day (post 06:00)</li>
                <li>bed — $15 / failed day</li>
                <li>screentime — $10 / failed day (any bucket over)</li>
                <li>worship — $0 / failed day (dormant — Harley sets target)</li>
                <li>edges — $0 / failed day (dormant — Harley sets target)</li>
                <li>gym — $25 × shortfall below 4 / week</li>
                <li>steps — $10 × days under 10k / week</li>
                <li>water — $20 / failed week</li>
                <li>writing — $30 / failed week (&lt;8 hr Obsidian)</li>
                <li>protein — $20 / failed week (&lt;5 days hit target)</li>
              </ul>
              <p className="text-zinc-500 mt-2 text-xs">
                Daily rules look back 7 days each run (catch-up safe). Weekly
                rules only evaluate on Sunday night for the just-ending Mon–Sun;
                activity logged 22:00–23:59 Sun rolls into the next week. Defaults
                shown above; live amounts overridable from the Harley panel.
                <br />
                <strong>gym</strong>: e.g. only 2 of 4 sessions done = 2 × $25 = $50.
                <strong>steps</strong>: e.g. 3 days under 10k = 3 × $10 = $30. One
                Punishments row per week regardless of severity; the per-shortfall
                math is baked into the row&rsquo;s amount.
                <br />
                <strong>worship</strong> and <strong>edges</strong> stay dormant
                until BOTH the Daily targets slider on the Harley panel AND the
                Fine schedule amount are set above 0.
              </p>
            </li>
          </ul>
        </section>

        {/* Notification rules */}
        <section className="mb-12">
          <h2 className="text-xl font-bold tracking-wide mb-4">Notifications</h2>
          <ul className="space-y-3 text-sm">
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Harley calendar task → Telegram</p>
              <p className="text-zinc-400 mt-1">
                Every 5 minutes, GitHub Actions hits{" "}
                <code className="bg-black/40 px-1">/api/cron/calendar-poll</code>.
                Any new Harley-authored event in the rolling 30-day-back / 7-day-forward
                window DMs Daniel via Telegram exactly once. Idempotent against the
                Calendar Events sheet snapshot.
              </p>
            </li>
            <li className="border border-[#222] bg-[#0f0f0f]/60 px-4 py-3 rounded">
              <p className="font-semibold text-white">Auth-config drift → Telegram</p>
              <p className="text-zinc-400 mt-1">
                Whenever HARLEY_EMAIL or related auth config flips, a Telegram
                fires so the change can&rsquo;t go unnoticed.
              </p>
            </li>
          </ul>
        </section>

        <p className="text-xs text-zinc-600">
          Want to change a threshold? Edit{" "}
          <code className="bg-black/40 px-1">src/lib/harley-meter.ts</code>, push, and this
          page updates on the next deploy.
        </p>
      </div>
    </div>
  );
}
