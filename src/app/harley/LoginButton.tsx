"use client";

import { useState } from "react";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

export function LoginButton() {
  const [state, setState] = useState<State>({ kind: "idle" });

  const onClick = async () => {
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/harley/login-request", { method: "POST" });
      if (res.ok) {
        setState({ kind: "sent" });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setState({
        kind: "error",
        message: body.error || `HTTP ${res.status}`,
      });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center p-8">
      <div className="max-w-sm w-full text-center">
        <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase mb-2">
          Goddess Control Panel
        </p>
        <p className="text-sm text-zinc-400 mb-8">
          Access via Telegram magic link.
        </p>

        {state.kind === "idle" && (
          <button
            type="button"
            onClick={onClick}
            className="px-5 py-3 text-xs font-semibold uppercase tracking-widest border border-purple-500 bg-purple-900/60 text-purple-100 hover:border-purple-300 hover:bg-purple-800/70 transition-colors"
          >
            Send access link
          </button>
        )}

        {state.kind === "sending" && (
          <p className="text-sm text-zinc-400">Sending…</p>
        )}

        {state.kind === "sent" && (
          <p className="text-sm text-emerald-300">
            Sent ✓ Check your email for the access link. It expires in 15 minutes.
          </p>
        )}

        {state.kind === "error" && (
          <>
            <p className="text-sm text-rose-300 mb-3">Failed: {state.message}</p>
            <button
              type="button"
              onClick={onClick}
              className="px-4 py-2 text-xs font-semibold uppercase tracking-widest border border-zinc-600 text-zinc-300 hover:border-zinc-400 hover:text-white transition-colors"
            >
              Retry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
