"use client";

import { useEffect, useState } from "react";

type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
};

function diff(targetMs: number, nowMs: number): Remaining {
  const ms = Math.max(0, targetMs - nowMs);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return { days, hours, minutes, seconds };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export default function DenialClock() {
  // undefined = still loading; null = fetched but no target set
  const [endDate, setEndDate] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/denial")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const v = d && typeof d.endDate === "string" ? d.endDate : null;
        setEndDate(v);
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

  if (endDate === undefined) {
    return <p className="text-xs text-zinc-500 italic">loading…</p>;
  }

  const targetMs = endDate ? Date.parse(endDate) : NaN;
  const released = !endDate || isNaN(targetMs) || targetMs <= now;

  if (released) {
    return (
      <>
        <p className="text-3xl font-bold text-green-400 mb-2">RELEASED</p>
        <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
          {endDate ? "target reached" : "no target set"}
        </p>
      </>
    );
  }

  const r = diff(targetMs, now);
  return (
    <>
      <p className="text-[10px] font-bold tracking-widest text-red-400 uppercase mb-2">
        LOCKED
      </p>
      <p className="text-2xl font-bold text-white tabular-nums mb-1">
        {r.days}d {pad2(r.hours)}h {pad2(r.minutes)}m {pad2(r.seconds)}s
      </p>
      <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
        until release
      </p>
    </>
  );
}
