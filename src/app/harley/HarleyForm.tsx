"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  clearDenialAction,
  extendDenialAction,
  setDenialDateAction,
  setOrgasmAllowedAdminAction,
} from "./actions";

type ActionResult = { ok: true } | { ok: false; error: string } | { ok: true; newEndDate: string };

type SyncResult = {
  ok: boolean;
  whoop: "ok" | "error" | "not_connected" | "not_configured";
  whoopDetail?: string;
  manualAsks: string[];
  emailSent: boolean;
};

export function HarleyForm({
  endDate,
  allowed,
}: {
  endDate: string | null;
  allowed: "yes" | "no";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [absoluteDate, setAbsoluteDate] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | { error: string } | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const run = (label: string, fn: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        flash(`${label} ✓`);
        router.refresh();
      } else {
        flash(`Error: ${(res as { error: string }).error}`);
      }
    });
  };

  const onAdd = (days: number, label: string) => {
    run(label, () => extendDenialAction(days));
  };

  const onApplyDate = () => {
    if (!absoluteDate) {
      flash("Pick a date first");
      return;
    }
    run("Date set", () => setDenialDateAction(absoluteDate));
  };

  const onClear = () => {
    if (!confirm("Clear the denial target? Countdown will disappear.")) return;
    run("Cleared", () => clearDenialAction());
  };

  const onAllow = () => {
    if (!confirm("Allow him now?")) return;
    run("Allowed", () => setOrgasmAllowedAdminAction("yes"));
  };

  const onDeny = () => {
    if (!confirm("Deny him now?")) return;
    run("Denied", () => setOrgasmAllowedAdminAction("no"));
  };

  const onSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync/trigger", { method: "POST" });
      const body = (await res.json()) as SyncResult | { error: string };
      setSyncResult(body);
      if ("ok" in body && body.ok) {
        flash("Synced ✓");
      } else if ("error" in body) {
        flash(`Sync error: ${body.error}`);
      } else {
        flash("Sync had issues — see details");
      }
    } catch (e) {
      const msg = (e as Error).message;
      setSyncResult({ error: msg });
      flash(`Sync failed: ${msg}`);
    } finally {
      setSyncing(false);
    }
  };

  const summary = describeEndDate(endDate);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-5">
      <div className="max-w-md mx-auto">
        <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase">
          Goddess Control Panel
        </p>
        <p className="text-sm text-zinc-400 mt-1 mb-5">
          Set or extend his denial. He cannot see this page.
        </p>

        {/* Current state */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Current state
          </p>
          <p className="text-sm mb-1">
            Status:{" "}
            <span
              className={`font-semibold ${
                allowed === "yes" ? "text-emerald-300" : "text-rose-300"
              }`}
            >
              ● {allowed === "yes" ? "Allowed" : "Denied"}
            </span>
          </p>
          <p className="text-sm">
            Target:{" "}
            <span className="font-mono text-zinc-300">
              {endDate || "(none)"}
            </span>
          </p>
          {summary && (
            <p className="text-xs text-zinc-500 mt-1">{summary}</p>
          )}
        </div>

        {/* Quick add */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Add time
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Adds to the current target if still future, otherwise to now.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <QuickButton onClick={() => onAdd(1, "+1 day")} disabled={isPending}>
              +1 day
            </QuickButton>
            <QuickButton onClick={() => onAdd(3, "+3 days")} disabled={isPending}>
              +3 days
            </QuickButton>
            <QuickButton onClick={() => onAdd(7, "+1 week")} disabled={isPending}>
              +1 week
            </QuickButton>
            <QuickButton onClick={() => onAdd(14, "+2 weeks")} disabled={isPending}>
              +2 weeks
            </QuickButton>
            <QuickButton onClick={() => onAdd(30, "+1 month")} disabled={isPending}>
              +1 month
            </QuickButton>
            <QuickButton onClick={() => onAdd(90, "+3 months")} disabled={isPending}>
              +3 months
            </QuickButton>
          </div>
        </div>

        {/* Set absolute */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Set exact date
          </p>
          <input
            type="datetime-local"
            value={absoluteDate}
            onChange={(e) => setAbsoluteDate(e.target.value)}
            className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 p-2 mb-2 focus:outline-none focus:border-purple-500 [color-scheme:dark]"
          />
          <button
            type="button"
            onClick={onApplyDate}
            disabled={isPending}
            className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50"
          >
            Apply
          </button>
          <p className="text-[10px] text-zinc-500 mt-2">
            Time in Sydney. Replaces the current target.
          </p>
        </div>

        {/* Sync Now */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Sync now
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Pulls fresh Whoop data and emails Daniel a manual-asks list for the rest.
          </p>
          <button
            type="button"
            onClick={onSyncNow}
            disabled={syncing || isPending}
            className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {syncResult && (
            <div className="mt-3 text-[11px] text-zinc-300 font-mono">
              {"error" in syncResult ? (
                <p className="text-rose-300">Error: {syncResult.error}</p>
              ) : (
                <>
                  <p>
                    Whoop:{" "}
                    <span
                      className={
                        syncResult.whoop === "ok"
                          ? "text-emerald-300"
                          : "text-amber-300"
                      }
                    >
                      {syncResult.whoop}
                    </span>
                    {syncResult.whoopDetail && (
                      <span className="text-zinc-500"> · {syncResult.whoopDetail}</span>
                    )}
                  </p>
                  <p className="mt-1">
                    Daniel email:{" "}
                    <span className={syncResult.emailSent ? "text-emerald-300" : "text-amber-300"}>
                      {syncResult.emailSent ? "sent" : "not sent"}
                    </span>
                  </p>
                  <p className="mt-2 text-zinc-400">Manual asks emailed to Daniel:</p>
                  <ul className="mt-1 list-disc pl-4 text-zinc-400">
                    {syncResult.manualAsks.map((a, i) => (
                      <li key={i} className="break-words">{a}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {/* Toggle + clear */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
            Override
          </p>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <button
              type="button"
              onClick={onAllow}
              disabled={isPending || allowed === "yes"}
              className="px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:border-emerald-400 hover:bg-emerald-900/60 transition-colors disabled:opacity-40"
            >
              Allow now
            </button>
            <button
              type="button"
              onClick={onDeny}
              disabled={isPending || allowed === "no"}
              className="px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-rose-700 bg-rose-950/40 text-rose-200 hover:border-rose-400 hover:bg-rose-900/60 transition-colors disabled:opacity-40"
            >
              Deny now
            </button>
          </div>
          <button
            type="button"
            onClick={onClear}
            disabled={isPending}
            className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors disabled:opacity-50"
          >
            Clear denial target
          </button>
        </div>

        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-purple-900 border border-purple-500 text-white text-sm rounded shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-3 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function describeEndDate(endDate: string | null): string | null {
  if (!endDate) return null;
  const ms = Date.parse(endDate);
  if (isNaN(ms)) return "Unparseable target.";
  const diff = ms - Date.now();
  if (diff <= 0) return "Target has passed.";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h from now`;
}
