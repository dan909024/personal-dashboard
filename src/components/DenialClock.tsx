"use client";

import { useEffect, useState } from "react";

const TOTAL_DURATION_DAYS = 30;
const TOTAL_DURATION_MS = TOTAL_DURATION_DAYS * 86_400_000;

function diff(targetMs: number, nowMs: number) {
  const ms = Math.max(0, targetMs - nowMs);
  return {
    ms,
    days: Math.floor(ms / 86_400_000),
    hours: Math.floor((ms % 86_400_000) / 3_600_000),
    minutes: Math.floor((ms % 3_600_000) / 60_000),
  };
}

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Circular denial countdown rendered below the Denied pill in the Weakness
 * Altar header. The arc represents a 30-day reference window — fully drawn
 * at 30d remaining, shrinking as time progresses. Inside: days/hours/minutes
 * remaining. Below: lifetime edge count. Returns null while loading, when
 * no target is set, or once the target has passed. Ticks every 30s.
 */
export default function DenialClock({ totalEdgesEver }: { totalEdgesEver: number }) {
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
  const fraction = Math.max(0, Math.min(1, r.ms / TOTAL_DURATION_MS));

  const size = 96;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          className="-rotate-90"
          aria-hidden="true"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgb(76 5 25 / 0.6)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgb(251 113 133)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: "stroke-dashoffset 600ms ease-out" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-rose-100 leading-none tabular-nums">
          <span className="text-xl font-semibold tracking-tight">{r.days}d</span>
          <span className="text-[10px] text-rose-200/80 mt-0.5">
            {pad2(r.hours)}h {pad2(r.minutes)}m
          </span>
        </div>
      </div>
      <div className="text-[10px] uppercase tracking-widest text-rose-200/70">
        Total edges:{" "}
        <span className="text-rose-100 font-semibold">{totalEdgesEver}</span>
      </div>
    </div>
  );
}
