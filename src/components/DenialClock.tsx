"use client";

import { useEffect, useState } from "react";

function diff(targetMs: number, nowMs: number) {
  const ms = Math.max(0, targetMs - nowMs);
  return {
    days: Math.floor(ms / 86_400_000),
    hours: Math.floor((ms % 86_400_000) / 3_600_000),
    minutes: Math.floor((ms % 3_600_000) / 60_000),
  };
}

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Live denial countdown rendered below the Denied pill in the Weakness
 * Altar header. Days / hours / minutes only — seconds are dropped so the
 * counter can be larger without flickering once a second. Returns null
 * while loading, when no target is set, or once the target has passed.
 * Ticks every 30s — half a minute is fine resolution for a m-precision
 * clock and keeps the page idle most of the time.
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
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!endDate) return null;
  const targetMs = Date.parse(endDate);
  if (isNaN(targetMs) || targetMs <= now) return null;

  const r = diff(targetMs, now);
  return (
    <span className="text-xl font-semibold text-rose-100 tabular-nums tracking-tight">
      {r.days}d {pad2(r.hours)}h {pad2(r.minutes)}m
    </span>
  );
}
