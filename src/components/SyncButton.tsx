"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type SyncResponse = {
  ok: boolean;
  whoop: "ok" | "error" | "not_connected" | "not_configured";
  whoopDetail?: string;
  screentime: "queued" | "error" | "not_configured";
  screentimeDetail?: string;
  manualAsks: string[];
  syncedAt: string;
};

type State =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "done"; data: SyncResponse; at: number }
  | { kind: "error"; message: string; retryAfterSec?: number };

const FADE_AFTER_MS = 60_000;

export function SyncButton() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const router = useRouter();
  // Re-render every second while a result is showing so the
  // "Synced Xs ago" label stays current.
  const [, setNow] = useState(0);

  useEffect(() => {
    if (state.kind !== "done") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const fade = setTimeout(() => setState({ kind: "idle" }), FADE_AFTER_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(fade);
    };
  }, [state.kind]);

  async function onClick() {
    if (state.kind === "syncing") return;
    setState({ kind: "syncing" });
    try {
      const res = await fetch("/api/dashboard/sync/trigger", { method: "POST" });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        setState({
          kind: "error",
          message: "Wait a moment",
          retryAfterSec: data?.retryAfterSec,
        });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as SyncResponse;
      setState({ kind: "done", data, at: Date.now() });
      startTransition(() => router.refresh());
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        disabled={state.kind === "syncing"}
        className="group flex items-center gap-1.5 px-2 py-1 border border-[#333] hover:border-zinc-500 disabled:hover:border-[#333] text-[10px] font-semibold uppercase tracking-widest text-zinc-300 hover:text-white disabled:text-zinc-500 transition-colors"
        aria-label="Sync now"
      >
        <SyncIcon spinning={state.kind === "syncing"} />
        <span>{buttonLabel(state)}</span>
      </button>
      {state.kind === "done" && <DonePanel data={state.data} />}
      {state.kind === "error" && <ErrorPanel state={state} />}
    </div>
  );
}

function buttonLabel(state: State): string {
  switch (state.kind) {
    case "idle":
      return "Sync";
    case "syncing":
      return "Syncing…";
    case "done":
      return `Synced ${secondsAgo(state.at)}s ago`;
    case "error":
      return "Sync";
  }
}

function secondsAgo(at: number): number {
  return Math.max(1, Math.floor((Date.now() - at) / 1000));
}

function SyncIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={spinning ? "animate-spin" : ""}
      aria-hidden
    >
      <path
        d="M2.5 8a5.5 5.5 0 0 1 9.9-3.3L14 3.5V7H10.5l1.5-1.5A4 4 0 0 0 4 8H2.5Zm11 0a5.5 5.5 0 0 1-9.9 3.3L2 12.5V9h3.5L4 10.5A4 4 0 0 0 12 8h1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function DonePanel({ data }: { data: SyncResponse }) {
  return (
    <div className="absolute right-0 top-full mt-1 z-20 w-72 border border-[#333] bg-black/90 backdrop-blur-sm p-3 text-[11px] text-zinc-300">
      <p className="mb-1.5">
        <span className="text-zinc-500 uppercase tracking-widest text-[9px]">Whoop:</span>{" "}
        <span className={whoopColor(data.whoop)}>{data.whoop}</span>
        {data.whoopDetail && (
          <span className="text-zinc-500"> · {data.whoopDetail}</span>
        )}
      </p>
      <p className="mb-1.5">
        <span className="text-zinc-500 uppercase tracking-widest text-[9px]">Screen Time:</span>{" "}
        <span className={screentimeColor(data.screentime)}>{data.screentime}</span>
        {data.screentimeDetail && (
          <span className="text-zinc-500"> · {data.screentimeDetail}</span>
        )}
      </p>
      {data.manualAsks.length > 0 && (
        <div className="border-t border-[#222] pt-2">
          <p className="text-zinc-500 uppercase tracking-widest text-[9px] mb-1">
            Manual asks (fire on your devices)
          </p>
          <ul className="space-y-0.5">
            {data.manualAsks.map((a, i) => (
              <li key={i} className="text-zinc-400 break-words">
                · {a}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ErrorPanel({ state }: { state: Extract<State, { kind: "error" }> }) {
  return (
    <div className="absolute right-0 top-full mt-1 z-20 w-56 border border-red-900 bg-black/90 backdrop-blur-sm p-2 text-[11px] text-red-300">
      {state.message}
      {state.retryAfterSec !== undefined && (
        <span className="text-zinc-500"> · retry in {state.retryAfterSec}s</span>
      )}
    </div>
  );
}

function whoopColor(s: SyncResponse["whoop"]): string {
  switch (s) {
    case "ok":
      return "text-green-400";
    case "not_connected":
      return "text-amber-400";
    case "not_configured":
      return "text-amber-400";
    case "error":
      return "text-red-400";
  }
}

function screentimeColor(s: SyncResponse["screentime"]): string {
  switch (s) {
    case "queued":
      return "text-green-400";
    case "not_configured":
      return "text-amber-400";
    case "error":
      return "text-red-400";
  }
}
