"use client";

import { useEffect, useState } from "react";

function diff(targetMs: number, nowMs: number) {
  const ms = Math.max(0, targetMs - nowMs);
  return {
    days: Math.floor(ms / 86_400_000),
    hours: Math.floor((ms % 86_400_000) / 3_600_000),
    minutes: Math.floor((ms % 3_600_000) / 60_000),
    seconds: Math.floor((ms % 60_000) / 1000),
  };
}

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Inline countdown rendered next to the Denied pill in the Weakness Altar
 * header. Returns null while loading, when no target is set, or once the
 * target has passed — that way the parent can render `Denied <DenialClock />`
 * unconditionally and the clock just disappears when there's nothing to show.
 */
export default function DenialClock() {
  const [endDate, setEndDate] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/denial")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setEndDate(d && typeof d.endDate === "string" ? d.endDate : null);
      })
      .catch(() => {
        if (!cancelled) setEndDate(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!endDate) return null;
  const targetMs = Date.parse(endDate);
  if (isNaN(targetMs) || targetMs <= now) return null;

  const r = diff(targetMs, now);
  return (
    <>
      <span className="text-zinc-600">·</span>
      <span className="tabular-nums">
        {r.days}d {pad2(r.hours)}h {pad2(r.minutes)}m {pad2(r.seconds)}s
      </span>
    </>
  );
}
