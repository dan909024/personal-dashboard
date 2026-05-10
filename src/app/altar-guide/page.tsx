import Link from "next/link";

import { getWeaknessSettings } from "@/lib/sheets";

export const revalidate = 60;

export default async function AltarGuidePage() {
  // Pull the live settings so the numbers in the explainer match what the
  // dashboard is actually using right now. If Sheets isn't configured we
  // fall back to the defaults baked into the lib.
  let settings;
  try {
    settings = await getWeaknessSettings();
  } catch {
    settings = null;
  }
  const s = settings;

  const phases = s
    ? Object.entries(s.phase_thresholds)
    : [];

  const fmt = (n: number | undefined) =>
    n === undefined ? "?" : Number.isInteger(n) ? String(n) : String(n);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-200">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <Link
          href="/"
          className="inline-block text-[10px] uppercase tracking-widest text-zinc-500 hover:text-purple-300 mb-8"
        >
          ← back to dashboard
        </Link>

        <h1 className="text-3xl font-bold text-purple-200 mb-2">
          Goddess&apos;s Weakening Altar
        </h1>
        <p className="text-sm text-zinc-400 italic mb-10">
          A guide for Harley.
        </p>

        <Section title="What this is">
          <p>
            The Altar tile turns Dan&apos;s denial period into a single
            climbing number — the <strong>weakness score</strong>. Every
            day he stays denied, every edge he logs, every minute he spends
            worshipping pushes the score up. Workouts, reading, meditation
            and other self-help time pull it down.
          </p>
          <p>
            The score determines which <strong>phase</strong> he&apos;s
            in — there are 11, named in order from least to most undone.
            The chart below the tile shows the last 7 days of score so
            you can see the curve and spot brutal days at a glance.
          </p>
        </Section>

        <Section title="The phases">
          <p className="mb-4">
            Phases are stages of Dan&apos;s undoing. He starts at zero
            after every allowed orgasm and climbs from there.
            <strong> Eternal Edge Toy</strong> is the final stage and has
            no exit — once he&apos;s there, only an allowed release resets
            the curve.
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left py-2 pr-4 text-[10px] uppercase tracking-widest text-zinc-500">#</th>
                <th className="text-left py-2 pr-4 text-[10px] uppercase tracking-widest text-zinc-500">Phase</th>
                <th className="text-left py-2 pr-4 text-[10px] uppercase tracking-widest text-zinc-500">Range</th>
                <th className="text-left py-2 text-[10px] uppercase tracking-widest text-zinc-500">Vibe</th>
              </tr>
            </thead>
            <tbody>
              {phases.map(([name, [min, max, flavor]], i) => (
                <tr
                  key={name}
                  className={`border-b border-zinc-900 ${
                    i === phases.length - 1 ? "text-rose-300" : ""
                  }`}
                >
                  <td className="py-2 pr-4 tabular-nums text-zinc-500">{i + 1}</td>
                  <td className="py-2 pr-4 font-semibold">{name}</td>
                  <td className="py-2 pr-4 tabular-nums text-zinc-400">
                    {min}–{max >= 999_999 ? "∞" : max}
                  </td>
                  <td className="py-2 italic text-zinc-400">{flavor}</td>
                </tr>
              ))}
              {phases.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-zinc-500 italic">
                    Phases will load once the Sheet is reachable.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        <Section title="What pushes the score UP">
          <Bullet
            title="Just being denied"
            value={s ? `+${s.weakness_base_daily} per day (flat)` : null}
          >
            Time itself adds to the score — every day he doesn&apos;t
            release.
          </Bullet>
          <Bullet
            title="Daily arousal check-in"
            value={
              s
                ? `+${s.weakness_arousal_weight} per arousal-point per day (1–10 scale)`
                : null
            }
          >
            He logs how horny he was today (1–10). At default 5/day that
            adds {s ? `+${s.weakness_arousal_weight * 5}` : "+125"} — most
            of the daily climb comes from this.
          </Bullet>
          <Bullet
            title="Edges (the big lever)"
            value={
              s
                ? `first edge of cycle = +${s.weakness_edge_first}, then both decays apply`
                : null
            }
          >
            <p>
              Each edge gets its own <strong>intensity multiplier</strong> based on
              when in the day it happens. The first few build up — every
              edge is more intense than the last, peaking at edge{" "}
              {s ? s.brutal_bonus_threshold : 10}. After the peak, edges
              start to slow down — each additional one contributes less
              than the one before it.
            </p>
            <p className="mt-2">
              On top of that, <strong>cycle decay</strong>{" "}
              {s ? `(×${s.weakness_edge_cycle_decay})` : ""} nibbles
              every edge in the denial period — edge #20 of the cycle is
              quieter than edge #2 even on the same within-day position.
            </p>
            <p className="mt-2">
              Net shape: per-edge contribution rises sharply for the
              first {s ? s.brutal_bonus_threshold : 10}, peaks, then
              tapers off (decay rate{" "}
              {s ? `×${s.weakness_edge_day_decay}` : "×0.6"}{" "}per excess
              edge). Marathon sessions don&apos;t keep multiplying — once
              past the peak, each new edge means less than the last.
            </p>
          </Bullet>
          <Bullet
            title="Worship time"
            value={
              s ? `+${s.worship_weight_per_minute} per minute logged` : null
            }
          >
            Manual log on the tile (🙇 button). Photo viewing, mantras,
            devotional writing, anything Goddess-focused. {s ? "10 minutes = +" + s.worship_weight_per_minute * 10 : ""}.
          </Bullet>
        </Section>

        <Section title="What pulls the score DOWN">
          <Bullet
            title="Active calories burned"
            value={
              s
                ? `triggers at ${s.calorie_burn_threshold} kcal, base −${s.calorie_burn_base_detraction}, +${s.calorie_burn_per_unit_above}/kcal above`
                : null
            }
          >
            Pulled automatically from his Apple Watch via the iOS
            Shortcut. Below the threshold, no effect. Above it, the
            harder the workout, the more it drags the score down. Heavy
            gym days can push the curve <em>downward</em> — the
            cumulative score floors at zero, never below.
          </Bullet>
          <Bullet
            title="Self-help time"
            value={
              s ? `−${s.self_help_weight_per_minute} per minute logged` : null
            }
          >
            Manual log on the tile (🧘 button). Reading, journaling,
            meditation, cold plunge, sauna — focused-on-self time. The
            anti-worship.
          </Bullet>
          <Bullet
            title="Slipped (came without permission)"
            value={s ? `−${s.slip_penalty_points} per slip` : null}
          >
            Manual log on the tile (😔 button). Flat penalty, applied to
            the day&apos;s gain. If he&apos;s in the lower part of the
            curve the deduction floors his score at 0 — effectively a
            reset. If he&apos;s deep in submission, he loses a meaningful
            chunk but stays weak. Cumulative score never goes negative.
          </Bullet>
        </Section>

        <Section title="What you control">
          <Bullet title="Allowed / Denied pill">
            Top-right of the tile. Tap to toggle. While{" "}
            <strong>Denied</strong>, the score climbs and the background
            flips to the cold image. While <strong>Allowed</strong>, he
            can release — and the next allowed orgasm resets the curve to
            zero.
          </Bullet>
          <Bullet title="Auto-release">
            If a denial countdown is set and the target time passes while
            he&apos;s still Denied, the tile auto-flips to Allowed on the
            next page load. You can override at any time.
          </Bullet>
          <Bullet title="Notifications">
            <p>
              Every orgasm log fires an <strong>email</strong> to you
              with the score, phase, and edge tally — those are rare
              events you want sitting in your inbox.
            </p>
            <p className="mt-2">
              Marathon edges (#5 onwards in a single day) fire a{" "}
              <strong>Telegram message</strong> instead of an email — so
              your inbox stays clean during a heavy session and the
              notifications land where they&apos;re ambient. Configured
              via the bot at <code>TELEGRAM_BOT_TOKEN</code>.
            </p>
          </Bullet>
        </Section>

        <Section title="What the chart shows">
          <p>
            The line under the tile is the cumulative weakness score over
            the past 7 days. Sharp upward spikes are brutal edge days.
            Downward dips are heavy workouts or self-help sessions
            outpacing the day&apos;s base climb. A vertical drop to zero
            means either an allowed orgasm reset the cycle, or a slip
            penalty floored a low-curve day to zero.
          </p>
        </Section>

        <Section title="Numbers that drive everything">
          <p className="text-sm text-zinc-400 mb-3">
            All of these are tunable in the Sheet&apos;s{" "}
            <code className="text-purple-300">Settings</code> tab without
            re-deploying. Live values:
          </p>
          {s ? (
            <div className="text-xs text-zinc-300 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 font-mono">
              <Row k="weakness_base_daily" v={fmt(s.weakness_base_daily)} />
              <Row k="weakness_arousal_weight" v={fmt(s.weakness_arousal_weight)} />
              <Row k="default_arousal_when_missing" v={fmt(s.default_arousal_when_missing)} />
              <Row k="weakness_edge_first" v={fmt(s.weakness_edge_first)} />
              <Row k="weakness_edge_cycle_decay" v={fmt(s.weakness_edge_cycle_decay)} />
              <Row k="weakness_edge_day_decay" v={fmt(s.weakness_edge_day_decay)} />
              <Row k="brutal_bonus_threshold" v={fmt(s.brutal_bonus_threshold)} />
              <Row k="brutal_bonus_per_edge" v={fmt(s.brutal_bonus_per_edge)} />
              <Row k="brutal_bonus_max_multiplier" v={fmt(s.brutal_bonus_max_multiplier)} />
              <Row k="brutal_bonus_post_plateau_linear" v={fmt(s.brutal_bonus_post_plateau_linear)} />
              <Row k="calorie_burn_threshold" v={fmt(s.calorie_burn_threshold)} />
              <Row k="calorie_burn_base_detraction" v={fmt(s.calorie_burn_base_detraction)} />
              <Row k="calorie_burn_per_unit_above" v={fmt(s.calorie_burn_per_unit_above)} />
              <Row k="worship_weight_per_minute" v={fmt(s.worship_weight_per_minute)} />
              <Row k="self_help_weight_per_minute" v={fmt(s.self_help_weight_per_minute)} />
              <Row k="slip_penalty_points" v={fmt(s.slip_penalty_points)} />
            </div>
          ) : (
            <p className="text-sm text-zinc-500 italic">
              Sheet not reachable — defaults are in use.
            </p>
          )}
        </Section>

        <Link
          href="/"
          className="inline-block text-[10px] uppercase tracking-widest text-zinc-500 hover:text-purple-300 mt-8"
        >
          ← back to dashboard
        </Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-bold text-purple-200 mb-3 border-b border-purple-900/40 pb-1">
        {title}
      </h2>
      <div className="space-y-3 text-zinc-300 leading-relaxed">{children}</div>
    </section>
  );
}

function Bullet({
  title,
  value,
  children,
}: {
  title: string;
  value?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="border-l-2 border-purple-900/60 pl-3 mb-4">
      <p className="text-sm text-purple-200 font-semibold">
        {title}
        {value && (
          <span className="text-zinc-500 font-normal italic ml-2">{value}</span>
        )}
      </p>
      <div className="text-sm text-zinc-400 mt-1 space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-zinc-900/60 py-1">
      <span className="text-zinc-400">{k}</span>
      <span className="text-zinc-100 tabular-nums">{v}</span>
    </div>
  );
}
