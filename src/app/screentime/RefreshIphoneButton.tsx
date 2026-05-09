"use client";
//
// "Refresh iPhone screen time" button. Writes a force-trigger
// timestamp to the Screen Time Control kv tab via
// POST /api/screentime/trigger; the Mac UI scraper polls that
// timestamp at the top of each launchd invocation and bypasses
// its idle/cooldown gates if it's fresh.
//
// Latency: up to one launchd interval (currently 2 minutes) +
// the scrape itself (3-5 minutes) before the new row appears in
// the Sheet.

import { useState } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "queued"; firedAt: string }
  | { kind: "error"; message: string };

export default function RefreshIphoneButton() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function trigger() {
    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/screentime/trigger", { method: "POST" });
      const body = (await res.json()) as
        | { ok: true; force_trigger_at: string }
        | { ok: false; error: string };
      if (!res.ok || !("force_trigger_at" in body)) {
        const message = "ok" in body && !body.ok ? body.error : `HTTP ${res.status}`;
        setStatus({ kind: "error", message });
        return;
      }
      setStatus({ kind: "queued", firedAt: body.force_trigger_at });
    } catch (e) {
      setStatus({ kind: "error", message: (e as Error).message });
    }
  }

  let label: string;
  if (status.kind === "loading") label = "Queueing…";
  else if (status.kind === "queued") label = "Queued — Mac picks up in ≤2 min";
  else if (status.kind === "error") label = `Failed: ${status.message}`;
  else label = "Refresh iPhone screen time";

  return (
    <button
      onClick={trigger}
      disabled={status.kind === "loading" || status.kind === "queued"}
      className="text-xs px-3 py-1.5 border border-[#333] bg-[#0f0f0f] hover:bg-[#1a1a1a] disabled:opacity-50 disabled:cursor-not-allowed text-zinc-300 transition"
    >
      {label}
    </button>
  );
}
