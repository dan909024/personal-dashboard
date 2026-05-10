"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  logDailyCheckInAction,
  logEdgeAction,
  logOrgasmAction,
  logSelfHelpAction,
  logWorshipAction,
  setOrgasmAllowedAction,
} from "@/app/actions/weakness";
import type { WeaknessDashboardData } from "@/lib/weakness";
import DenialClock from "@/components/DenialClock";

import { WeaknessChart } from "./WeaknessChart";

const ALTAR_TAGLINE = "One brutal day can break months of resistance.";

function scoreColor(score: number): string {
  if (score < 400) return "text-bloom-300";
  if (score < 800) return "text-ivory-300";
  if (score < 1200) return "text-ivory";
  if (score < 1600) return "text-coach-300";
  return "text-bloom-200";
}

function brutalIcon(multiplier: number): string {
  if (multiplier >= 3.5) return "🔥🔥🔥";
  if (multiplier >= 2.0) return "🔥🔥";
  if (multiplier > 1.0) return "🔥";
  return "";
}

function fmtMultiplier(m: number): string {
  return m.toFixed(m === Math.floor(m) ? 1 : 2);
}

export function WeaknessAltarTile({
  data,
  coachPhotoUrl = "/coach.jpg",
}: {
  data: WeaknessDashboardData;
  coachPhotoUrl?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [worshipOpen, setWorshipOpen] = useState(false);
  const [selfHelpOpen, setSelfHelpOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  };

  const runAction = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        flash(`${label} ✓`);
        router.refresh();
      } else {
        flash(`Failed: ${res.error || "unknown"}`);
      }
    });
  };

  const onAllowed = () => {
    if (!confirm("Log this as Goddess-allowed orgasm?")) return;
    runAction("Logged", () => logOrgasmAction("allowed"));
  };
  const onLapsed = () => {
    if (!confirm("Log this as a slip (lapsed orgasm)? Adds a $20 fine to Punishments.")) return;
    // Optional backdate. Empty/cancel = log at the current Sydney time.
    // Format strictly enforced server-side so typos don't write garbage.
    const raw = prompt(
      "When did the slip happen?\nEmpty = now.\nFormat: YYYY-MM-DD HH:MM (Sydney 24h, e.g. 2026-05-09 17:00)"
    );
    let backdate: { date: string; time: string } | undefined;
    if (raw && raw.trim()) {
      const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[\sT]+(\d{2}:\d{2})$/);
      if (!m) {
        alert("Couldn't parse — expected YYYY-MM-DD HH:MM. Aborting (nothing logged).");
        return;
      }
      backdate = { date: m[1], time: m[2] };
    }
    runAction("Logged", () => logOrgasmAction("lapsed", undefined, backdate));
  };
  const onEdge = () => {
    runAction("+1 edge", () => logEdgeAction());
  };
  const onTogglePill = () => {
    const next = data.orgasmAllowed === "yes" ? "no" : "yes";
    const verb = next === "yes" ? "Allow" : "Deny";
    if (!confirm(`${verb} now?`)) return;
    runAction(verb === "Allow" ? "Allowed" : "Denied", () =>
      setOrgasmAllowedAction(next)
    );
  };

  const score = data.weaknessScore;
  const phase = data.currentPhase;
  const nextLabel =
    phase.nextPhaseName && phase.nextPhaseThreshold !== null
      ? `→ ${phase.nextPhaseName} @ ${phase.nextPhaseThreshold}`
      : "→ (final phase)";
  const upperBound = phase.currentRangeMax >= 999_999 ? "∞" : phase.currentRangeMax;
  const brutal = brutalIcon(data.todayBrutalMultiplier);
  const showBrutal = data.todayBrutalMultiplier > 1.0;
  const spiral = data.todayBrutalMultiplier >= 3.5;

  return (
    <div className="tile-card-bloom p-5 col-span-1 md:col-span-3 rounded-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="brand-serif text-[12px] font-semibold tracking-[0.22em] text-bloom-200 uppercase">
            Goddess&apos;s Weakening Altar
            <a
              href="/altar-guide"
              className="ml-2 text-ivory-400/60 hover:text-bloom-200 normal-case tracking-normal text-[11px] font-sans font-normal"
              title="How this works"
            >
              guide ↗
            </a>
          </p>
          <p className="brand-serif italic text-[12px] text-ivory-300/80 mt-0.5">{ALTAR_TAGLINE}</p>
        </div>
        <button
          type="button"
          onClick={() => setPhotoOpen(true)}
          aria-label="View Harley full size"
          title="Click to view full photo"
          className="hidden sm:block w-20 h-20 md:w-24 md:h-24 shrink-0 rounded-full bg-cover bg-top ring-2 ring-bloom/60 hover:ring-bloom-200 hover:scale-[1.03] transition-all shadow-lg cursor-pointer self-center"
          style={{ backgroundImage: `url('${coachPhotoUrl}')` }}
        />
        <div className="flex flex-col items-end gap-2 shrink-0">
          {data.orgasmAllowed === "yes" ? (
            <button
              type="button"
              onClick={onTogglePill}
              disabled={isPending}
              title="Click to toggle Allowed / Denied"
              className="text-[10px] uppercase tracking-widest flex items-center gap-1.5 px-2 py-0.5 border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sage-200 border-sage-700 hover:border-sage-300 hover:bg-sage-900/40"
            >
              <span className="w-2 h-2 rounded-full inline-block bg-sage" />
              Allowed
            </button>
          ) : (
            <button
              type="button"
              onClick={onTogglePill}
              disabled={isPending}
              title="Click to toggle Allowed / Denied"
              className="text-right border border-bloom-800 hover:border-bloom-600 bg-bloom-900/30 hover:bg-bloom-900/50 transition-colors px-2.5 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <p className="brand-serif text-[10px] uppercase tracking-[0.22em] text-bloom-200/80 mb-0.5">
                Harley says
              </p>
              <ul className="space-y-0.5 text-[11px] text-bloom-100 leading-tight">
                <li className="flex items-center gap-1.5 justify-end">
                  Stay pussy free <Tick />
                </li>
                <li className="flex items-center gap-1.5 justify-end">
                  No cumming allowed <Tick />
                </li>
                <li className="flex items-center gap-1.5 justify-end">
                  Allowed to stroke and edge <Tick />
                </li>
              </ul>
            </button>
          )}
          {data.orgasmAllowed === "no" && (
            <DenialClock totalEdgesEver={data.totalEdgesEver} />
          )}
        </div>
      </div>

      {/* Phase + flavor */}
      <div className="mb-3">
        <p className="text-sm text-ivory-100/80">
          Phase: <span className="brand-serif text-bloom-200 font-semibold italic">{phase.name}</span>
        </p>
        <p className="text-xs text-ivory-400/70 italic">&ldquo;{phase.flavorText}&rdquo;</p>
      </div>

      {/* Score + progress bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <p className={`brand-serif text-3xl font-semibold tracking-tight ${scoreColor(score)}`}>
            {score}
            <span className="text-ivory-400/50 text-base font-normal"> / {upperBound}</span>
          </p>
          <p className="text-[10px] text-ivory-400/70 uppercase tracking-widest">{nextLabel}</p>
        </div>
        <div className="w-full h-2 bg-iron-200 rounded-sm overflow-hidden">
          <div
            className="h-2 bg-gradient-to-r from-bloom-700 via-bloom to-bloom-200"
            style={{ width: `${Math.max(0, Math.min(100, phase.percentToNext))}%` }}
          />
        </div>
        <p className="text-[10px] text-ivory-400/70 mt-1">{phase.percentToNext}% through phase</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-ivory-100/80 mb-3">
        <Stat label="Day denied" value={String(data.daysDenied)} />
        <Stat label="Edges total" value={String(data.totalEdgesSinceLast)} />
        <Stat label="Today edges" value={String(data.todayEdges)} />
        <Stat label="Today gain" value={`+${data.todayDailyGain}`} />
      </div>

      {showBrutal && (
        <div className="mb-3 text-xs">
          <span className="text-ivory-300 font-semibold">
            {brutal} Brutal ×{fmtMultiplier(data.todayBrutalMultiplier)}
          </span>
          {spiral && (
            <span className="ml-2 text-bloom-300 uppercase tracking-widest text-[10px]">
              Edging spiral active
            </span>
          )}
        </div>
      )}

      {/* Today's adjustments — only render when at least one is non-zero */}
      {(data.todayWorshipMinutes > 0 ||
        data.todaySelfHelpMinutes > 0 ||
        data.todayCalorieDetraction > 0) && (
        <div className="mb-3 flex flex-wrap gap-2 text-[10px] text-ivory-300/80">
          {data.todayWorshipMinutes > 0 && (
            <span className="px-2 py-0.5 border border-bloom-800 text-bloom-200">
              Worship {data.todayWorshipMinutes}m → +{data.todayWorshipContribution}
            </span>
          )}
          {data.todaySelfHelpMinutes > 0 && (
            <span className="px-2 py-0.5 border border-coach-800 text-coach-200">
              Self-help {data.todaySelfHelpMinutes}m → −{data.todaySelfHelpDetraction}
            </span>
          )}
          {data.todayCalorieDetraction > 0 && (
            <span className="px-2 py-0.5 border border-coach-800 text-coach-200">
              {data.todayActiveCalories} kcal burned → −{data.todayCalorieDetraction}
            </span>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        <ActionButton onClick={onAllowed} disabled={isPending} variant="sage">
          🙏 Thanks Goddess
        </ActionButton>
        <ActionButton onClick={onLapsed} disabled={isPending} variant="bloom">
          😔 Slipped
        </ActionButton>
        <ActionButton onClick={onEdge} disabled={isPending} variant="ivory">
          +1 edge ⚡
        </ActionButton>
        <ActionButton
          onClick={() => setWorshipOpen(true)}
          disabled={isPending}
          variant="bloomDeep"
        >
          🙇 Worship time
        </ActionButton>
        <ActionButton
          onClick={() => setSelfHelpOpen(true)}
          disabled={isPending}
          variant="coach"
        >
          🧘 Self-help time
        </ActionButton>
      </div>

      {/* Daily check-in pending */}
      {!data.hasArousalCheckInToday && (
        <div className="mb-3 flex items-center justify-between gap-2 px-2 py-1.5 border border-bloom-800 bg-bloom-900/30 text-[11px] text-bloom-200">
          <span>Daily check-in pending</span>
          <button
            type="button"
            onClick={() => setCheckInOpen(true)}
            className="px-2 py-1 border border-bloom-600 hover:border-bloom-300 uppercase tracking-widest text-[10px]"
          >
            Daily check-in
          </button>
        </div>
      )}

      {/* Chart */}
      <div className="mt-2 pt-3 border-t border-bloom-800/40">
        <p className="brand-serif text-[11px] font-semibold tracking-[0.22em] text-bloom-200 uppercase mb-2">
          Weakness progression for Goddess
        </p>
        <WeaknessChart data={data.weeklySeries} />
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-bloom-800 border border-bloom-300 text-ivory-50 text-sm rounded shadow-lg">
          {toast}
        </div>
      )}

      {/* Check-in modal */}
      {checkInOpen && (
        <CheckInModal
          onClose={() => setCheckInOpen(false)}
          onSubmit={(arousal, note) => {
            startTransition(async () => {
              const res = await logDailyCheckInAction(arousal, note);
              if (res.ok) {
                flash("Check-in saved ✓");
                setCheckInOpen(false);
                router.refresh();
              } else {
                flash(`Failed: ${res.error}`);
              }
            });
          }}
        />
      )}

      {/* Worship modal */}
      {worshipOpen && (
        <ActivityModal
          title="Log worship time"
          accent="bloom"
          submitLabel="Log worship"
          onClose={() => setWorshipOpen(false)}
          onSubmit={(activity, minutes, note) => {
            startTransition(async () => {
              const res = await logWorshipAction(activity, minutes, note);
              if (res.ok) {
                flash(`Worship +${minutes}m ✓`);
                setWorshipOpen(false);
                router.refresh();
              } else {
                flash(`Failed: ${res.error}`);
              }
            });
          }}
        />
      )}

      {/* Coach photo lightbox */}
      {photoOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-deep/95 backdrop-blur-sm p-4 cursor-zoom-out"
          onClick={() => setPhotoOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coachPhotoUrl}
            alt="Harley"
            className="max-w-full max-h-full object-contain shadow-2xl ring-2 ring-bloom/40"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPhotoOpen(false)}
            aria-label="Close"
            className="fixed top-4 right-4 w-10 h-10 flex items-center justify-center text-ivory text-2xl bg-ink-deep/70 border border-ivory/20 hover:border-bloom/60 hover:bg-ink-deep/90 transition-colors"
          >
            ×
          </button>
        </div>
      )}

      {/* Self-help modal */}
      {selfHelpOpen && (
        <ActivityModal
          title="Log self-help time"
          accent="coach"
          submitLabel="Log self-help"
          onClose={() => setSelfHelpOpen(false)}
          onSubmit={(activity, minutes, note) => {
            startTransition(async () => {
              const res = await logSelfHelpAction(activity, minutes, note);
              if (res.ok) {
                flash(`Self-help −${minutes}m ✓`);
                setSelfHelpOpen(false);
                router.refresh();
              } else {
                flash(`Failed: ${res.error}`);
              }
            });
          }}
        />
      )}
    </div>
  );
}

// ---------- Sub-components ----------

function Tick() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      className="shrink-0 text-sage"
      aria-hidden="true"
    >
      <path
        d="M3 8.5l3 3 7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-iron-100/70 bg-ink-deep/40 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-widest text-ivory-400/70">{label}</p>
      <p className="text-sm font-semibold text-ivory tabular-nums">{value}</p>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
  variant,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant: "sage" | "bloom" | "ivory" | "bloomDeep" | "coach";
}) {
  const variants: Record<string, string> = {
    sage:
      "border-sage-700 bg-sage-900/40 text-sage-100 hover:border-sage-300 hover:bg-sage-800/60",
    bloom:
      "border-bloom-700 bg-bloom-900/40 text-bloom-100 hover:border-bloom-300 hover:bg-bloom-800/60",
    ivory:
      "border-ivory-400 bg-ivory-400/10 text-ivory-100 hover:border-ivory hover:bg-ivory-400/20",
    bloomDeep:
      "border-bloom-800 bg-bloom-900/60 text-bloom-100 hover:border-bloom-300 hover:bg-bloom-800/70",
    coach:
      "border-coach-700 bg-coach-900/40 text-coach-100 hover:border-coach-300 hover:bg-coach-800/60",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 text-xs font-semibold uppercase tracking-widest border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

function ActivityModal({
  title,
  accent,
  submitLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  accent: "bloom" | "coach";
  submitLabel: string;
  onClose: () => void;
  onSubmit: (activity: string, minutes: number, note?: string) => void;
}) {
  const [activity, setActivity] = useState("");
  const [minutes, setMinutes] = useState(15);
  const [note, setNote] = useState("");
  const accentRing =
    accent === "bloom"
      ? "border-bloom-700 focus:border-bloom-400"
      : "border-coach-700 focus:border-coach-400";
  const submitClass =
    accent === "bloom"
      ? "border-bloom-400 bg-bloom-800/60 text-bloom-100 hover:border-bloom-200"
      : "border-coach-400 bg-coach-800/60 text-coach-100 hover:border-coach-200";
  const headerClass =
    accent === "bloom" ? "text-bloom-200" : "text-coach-200";
  const accentVar =
    accent === "bloom" ? "var(--color-bloom)" : "var(--color-coach)";
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-deep/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-sm border bg-iron-700 p-5 ${
          accent === "bloom" ? "border-bloom-700" : "border-coach-700"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={`brand-serif text-[12px] font-semibold tracking-[0.22em] uppercase mb-3 ${headerClass}`}>
          {title}
        </p>
        <label className="block text-xs text-ivory-100/80 mb-1">Activity</label>
        <input
          type="text"
          value={activity}
          onChange={(e) => setActivity(e.target.value)}
          placeholder={accent === "bloom" ? "e.g. photo viewing, mantra" : "e.g. reading, meditation"}
          className={`w-full text-sm bg-ink-deep/60 border text-ivory p-2 mb-3 focus:outline-none ${accentRing}`}
          style={{ accentColor: accentVar }}
          autoFocus
        />
        <label className="block text-xs text-ivory-100/80 mb-1">
          Minutes: <span className="font-bold text-ivory">{minutes}</span>
        </label>
        <input
          type="range"
          min={1}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          className="w-full mb-3"
          style={{ accentColor: accentVar }}
        />
        <label className="block text-xs text-ivory-100/80 mb-1">Note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className={`w-full text-xs bg-ink-deep/60 border text-ivory p-2 mb-4 focus:outline-none ${accentRing}`}
          style={{ accentColor: accentVar }}
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-iron-100 text-ivory-300/80 hover:border-iron-50 hover:text-ivory uppercase tracking-widest"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(activity, minutes, note || undefined)}
            disabled={!activity.trim()}
            className={`px-3 py-1.5 text-xs border uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed ${submitClass}`}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckInModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (arousal: number, note?: string) => void;
}) {
  const [arousal, setArousal] = useState(5);
  const [note, setNote] = useState("");
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-deep/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm border border-bloom-700 bg-iron-700 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="brand-serif text-[12px] font-semibold tracking-[0.22em] text-bloom-200 uppercase mb-3">
          Daily check-in
        </p>
        <label className="block text-xs text-ivory-100/80 mb-1">
          Arousal: <span className="font-bold text-bloom-200">{arousal}</span> / 10
        </label>
        <input
          type="range"
          min={1}
          max={10}
          value={arousal}
          onChange={(e) => setArousal(Number(e.target.value))}
          className="w-full mb-3"
          style={{ accentColor: "var(--color-bloom)" }}
        />
        <label className="block text-xs text-ivory-100/80 mb-1">Note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full text-xs bg-ink-deep/60 border border-bloom-800 text-ivory p-2 mb-4 focus:outline-none focus:border-bloom-400"
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-iron-100 text-ivory-300/80 hover:border-iron-50 hover:text-ivory uppercase tracking-widest"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(arousal, note || undefined)}
            className="px-3 py-1.5 text-xs border border-bloom-400 bg-bloom-800/60 text-bloom-100 hover:border-bloom-200 uppercase tracking-widest"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
