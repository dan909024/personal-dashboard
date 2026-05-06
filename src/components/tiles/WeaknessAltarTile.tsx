"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  logDailyCheckInAction,
  logEdgeAction,
  logOrgasmAction,
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

export function WeaknessAltarTile({ data }: { data: WeaknessDashboardData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [checkInOpen, setCheckInOpen] = useState(false);

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
    if (!confirm("Log this as a slip (lapsed orgasm)?")) return;
    runAction("Logged", () => logOrgasmAction("lapsed"));
  };
  const onEdge = () => {
    runAction("+1 edge", () => logEdgeAction());
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
        <div>
          <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase">
            Goddess&apos;s Weakening Altar
          </p>
          <p className="text-[11px] text-zinc-400 italic mt-0.5">{ALTAR_TAGLINE}</p>
        </div>
        <span
          className={`text-[10px] uppercase tracking-widest flex items-center gap-1.5 shrink-0 ${
            data.orgasmAllowed === "yes" ? "text-emerald-300" : "text-rose-300"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full inline-block ${
              data.orgasmAllowed === "yes" ? "bg-emerald-400" : "bg-rose-400"
            }`}
          />
          {data.orgasmAllowed === "yes" ? "Allowed" : "Denied"}
          {data.orgasmAllowed === "no" && <DenialClock />}
        </span>
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
    </div>
  );
}

// ---------- Sub-components ----------

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
  variant: "emerald" | "rose" | "amber";
}) {
  const variants: Record<string, string> = {
    emerald:
      "border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:border-emerald-400 hover:bg-emerald-900/60",
    rose:
      "border-rose-700 bg-rose-950/40 text-rose-200 hover:border-rose-400 hover:bg-rose-900/60",
    amber:
      "border-amber-700 bg-amber-950/40 text-amber-200 hover:border-amber-400 hover:bg-amber-900/60",
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
