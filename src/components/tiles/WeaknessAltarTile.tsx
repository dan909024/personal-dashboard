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
  if (score < 400) return "text-red-400";
  if (score < 800) return "text-orange-400";
  if (score < 1200) return "text-yellow-300";
  if (score < 1600) return "text-cyan-400";
  return "text-purple-400";
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
    runAction("Logged", () => logOrgasmAction("lapsed"));
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
    <div className="border border-purple-900/60 bg-[#120c1a]/90 backdrop-blur-sm p-4 col-span-1 md:col-span-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase">
            Goddess&apos;s Weakening Altar
            <a
              href="/altar-guide"
              className="ml-2 text-zinc-500 hover:text-purple-200 normal-case tracking-normal text-[11px]"
              title="How this works"
            >
              guide ↗
            </a>
          </p>
          <p className="text-[11px] text-zinc-400 italic mt-0.5">{ALTAR_TAGLINE}</p>
        </div>
        <button
          type="button"
          onClick={() => setPhotoOpen(true)}
          aria-label="View Harley full size"
          title="Click to view full photo"
          className="hidden sm:block w-20 h-20 md:w-24 md:h-24 shrink-0 rounded-full bg-cover bg-top ring-2 ring-rose-400/60 hover:ring-rose-300 hover:scale-[1.03] transition-all shadow-lg cursor-pointer self-center"
          style={{ backgroundImage: `url('${coachPhotoUrl}')` }}
        />
        <div className="flex flex-col items-end gap-2 shrink-0">
          {data.orgasmAllowed === "yes" ? (
            <button
              type="button"
              onClick={onTogglePill}
              disabled={isPending}
              title="Click to toggle Allowed / Denied"
              className="text-[10px] uppercase tracking-widest flex items-center gap-1.5 px-2 py-0.5 border transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-emerald-300 border-emerald-700 hover:border-emerald-400 hover:bg-emerald-950/40"
            >
              <span className="w-2 h-2 rounded-full inline-block bg-emerald-400" />
              Allowed
            </button>
          ) : (
            <button
              type="button"
              onClick={onTogglePill}
              disabled={isPending}
              title="Click to toggle Allowed / Denied"
              className="text-right border border-rose-900/60 hover:border-rose-700/80 bg-rose-950/30 hover:bg-rose-950/50 transition-colors px-2.5 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <p className="text-[9px] uppercase tracking-widest text-rose-300/80 mb-0.5">
                Harley says
              </p>
              <ul className="space-y-0.5 text-[11px] text-rose-100 leading-tight">
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
        <p className="text-sm text-zinc-300">
          Phase: <span className="text-purple-200 font-semibold">{phase.name}</span>
        </p>
        <p className="text-xs text-zinc-500 italic">&ldquo;{phase.flavorText}&rdquo;</p>
      </div>

      {/* Score + progress bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <p className={`text-3xl font-bold ${scoreColor(score)}`}>
            {score}
            <span className="text-zinc-600 text-base font-normal"> / {upperBound}</span>
          </p>
          <p className="text-[10px] text-zinc-500 uppercase tracking-widest">{nextLabel}</p>
        </div>
        <div className="w-full h-2 bg-[#1a1024] rounded-sm overflow-hidden">
          <div
            className="h-2 bg-gradient-to-r from-purple-700 via-fuchsia-500 to-purple-300"
            style={{ width: `${Math.max(0, Math.min(100, phase.percentToNext))}%` }}
          />
        </div>
        <p className="text-[10px] text-zinc-500 mt-1">{phase.percentToNext}% through phase</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-zinc-300 mb-3">
        <Stat label="Day denied" value={String(data.daysDenied)} />
        <Stat label="Edges total" value={String(data.totalEdgesSinceLast)} />
        <Stat label="Today edges" value={String(data.todayEdges)} />
        <Stat label="Today gain" value={`+${data.todayDailyGain}`} />
      </div>

      {showBrutal && (
        <div className="mb-3 text-xs">
          <span className="text-amber-300 font-semibold">
            {brutal} Brutal ×{fmtMultiplier(data.todayBrutalMultiplier)}
          </span>
          {spiral && (
            <span className="ml-2 text-rose-300 uppercase tracking-widest text-[10px]">
              Edging spiral active
            </span>
          )}
        </div>
      )}

      {/* Today's adjustments — only render when at least one is non-zero */}
      {(data.todayWorshipMinutes > 0 ||
        data.todaySelfHelpMinutes > 0 ||
        data.todayCalorieDetraction > 0) && (
        <div className="mb-3 flex flex-wrap gap-2 text-[10px] text-zinc-400">
          {data.todayWorshipMinutes > 0 && (
            <span className="px-2 py-0.5 border border-purple-900/60 text-purple-200">
              Worship {data.todayWorshipMinutes}m → +{data.todayWorshipContribution}
            </span>
          )}
          {data.todaySelfHelpMinutes > 0 && (
            <span className="px-2 py-0.5 border border-cyan-900/60 text-cyan-200">
              Self-help {data.todaySelfHelpMinutes}m → −{data.todaySelfHelpDetraction}
            </span>
          )}
          {data.todayCalorieDetraction > 0 && (
            <span className="px-2 py-0.5 border border-cyan-900/60 text-cyan-200">
              {data.todayActiveCalories} kcal burned → −{data.todayCalorieDetraction}
            </span>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        <ActionButton onClick={onAllowed} disabled={isPending} variant="emerald">
          🙏 Thanks Goddess
        </ActionButton>
        <ActionButton onClick={onLapsed} disabled={isPending} variant="rose">
          😔 Slipped
        </ActionButton>
        <ActionButton onClick={onEdge} disabled={isPending} variant="amber">
          +1 edge ⚡
        </ActionButton>
        <ActionButton
          onClick={() => setWorshipOpen(true)}
          disabled={isPending}
          variant="purple"
        >
          🙇 Worship time
        </ActionButton>
        <ActionButton
          onClick={() => setSelfHelpOpen(true)}
          disabled={isPending}
          variant="cyan"
        >
          🧘 Self-help time
        </ActionButton>
      </div>

      {/* Daily check-in pending */}
      {!data.hasArousalCheckInToday && (
        <div className="mb-3 flex items-center justify-between gap-2 px-2 py-1.5 border border-purple-900/60 bg-purple-950/40 text-[11px] text-purple-200">
          <span>Daily check-in pending</span>
          <button
            type="button"
            onClick={() => setCheckInOpen(true)}
            className="px-2 py-1 border border-purple-700 hover:border-purple-400 uppercase tracking-widest text-[10px]"
          >
            Daily check-in
          </button>
        </div>
      )}

      {/* Chart */}
      <div className="mt-2 pt-3 border-t border-purple-900/40">
        <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase mb-2">
          Weakness progression for Goddess
        </p>
        <WeaknessChart data={data.thirtyDaySeries} />
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-purple-900 border border-purple-500 text-white text-sm rounded shadow-lg">
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
          accent="purple"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 cursor-zoom-out"
          onClick={() => setPhotoOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coachPhotoUrl}
            alt="Harley"
            className="max-w-full max-h-full object-contain shadow-2xl ring-2 ring-rose-400/40"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setPhotoOpen(false)}
            aria-label="Close"
            className="fixed top-4 right-4 w-10 h-10 flex items-center justify-center text-white text-2xl bg-black/60 border border-white/20 hover:border-white/60 hover:bg-black/80 transition-colors"
          >
            ×
          </button>
        </div>
      )}

      {/* Self-help modal */}
      {selfHelpOpen && (
        <ActivityModal
          title="Log self-help time"
          accent="cyan"
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
      className="shrink-0 text-emerald-400"
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
    <div className="border border-purple-900/40 bg-black/30 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-widest text-zinc-500">{label}</p>
      <p className="text-sm font-semibold text-zinc-100 tabular-nums">{value}</p>
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
  variant: "emerald" | "rose" | "amber" | "purple" | "cyan";
}) {
  const variants: Record<string, string> = {
    emerald:
      "border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:border-emerald-400 hover:bg-emerald-900/60",
    rose:
      "border-rose-700 bg-rose-950/40 text-rose-200 hover:border-rose-400 hover:bg-rose-900/60",
    amber:
      "border-amber-700 bg-amber-950/40 text-amber-200 hover:border-amber-400 hover:bg-amber-900/60",
    purple:
      "border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60",
    cyan:
      "border-cyan-700 bg-cyan-950/40 text-cyan-200 hover:border-cyan-400 hover:bg-cyan-900/60",
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
  accent: "purple" | "cyan";
  submitLabel: string;
  onClose: () => void;
  onSubmit: (activity: string, minutes: number, note?: string) => void;
}) {
  const [activity, setActivity] = useState("");
  const [minutes, setMinutes] = useState(15);
  const [note, setNote] = useState("");
  const accentRing =
    accent === "purple"
      ? "border-purple-700 focus:border-purple-500 accent-purple-500"
      : "border-cyan-700 focus:border-cyan-500 accent-cyan-500";
  const submitClass =
    accent === "purple"
      ? "border-purple-500 bg-purple-900/60 text-purple-100 hover:border-purple-300"
      : "border-cyan-500 bg-cyan-900/60 text-cyan-100 hover:border-cyan-300";
  const headerClass =
    accent === "purple" ? "text-purple-300" : "text-cyan-300";
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-sm border bg-[#120c1a] p-5 ${
          accent === "purple" ? "border-purple-700" : "border-cyan-700"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={`text-[10px] font-bold tracking-widest uppercase mb-3 ${headerClass}`}>
          {title}
        </p>
        <label className="block text-xs text-zinc-300 mb-1">Activity</label>
        <input
          type="text"
          value={activity}
          onChange={(e) => setActivity(e.target.value)}
          placeholder={accent === "purple" ? "e.g. photo viewing, mantra" : "e.g. reading, meditation"}
          className={`w-full text-sm bg-black/40 border text-zinc-100 p-2 mb-3 focus:outline-none ${accentRing}`}
          autoFocus
        />
        <label className="block text-xs text-zinc-300 mb-1">
          Minutes: <span className="font-bold text-zinc-100">{minutes}</span>
        </label>
        <input
          type="range"
          min={1}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          className={`w-full mb-3 ${accentRing}`}
        />
        <label className="block text-xs text-zinc-300 mb-1">Note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className={`w-full text-xs bg-black/40 border text-zinc-100 p-2 mb-4 focus:outline-none ${accentRing}`}
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white uppercase tracking-widest"
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
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm border border-purple-700 bg-[#120c1a] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase mb-3">
          Daily check-in
        </p>
        <label className="block text-xs text-zinc-300 mb-1">
          Arousal: <span className="font-bold text-purple-200">{arousal}</span> / 10
        </label>
        <input
          type="range"
          min={1}
          max={10}
          value={arousal}
          onChange={(e) => setArousal(Number(e.target.value))}
          className="w-full accent-purple-500 mb-3"
        />
        <label className="block text-xs text-zinc-300 mb-1">Note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full text-xs bg-black/40 border border-purple-900 text-zinc-100 p-2 mb-4 focus:outline-none focus:border-purple-500"
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white uppercase tracking-widest"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(arousal, note || undefined)}
            className="px-3 py-1.5 text-xs border border-purple-500 bg-purple-900/60 text-purple-100 hover:border-purple-300 uppercase tracking-widest"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
