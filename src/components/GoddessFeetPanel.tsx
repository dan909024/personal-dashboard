"use client";

import { useEffect, useState } from "react";

const REVEAL_HEIGHT = 320;
const CURTAIN_DURATION_MS = 700;

export function GoddessFeetPanel() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setRevealed(true));
      return () => cancelAnimationFrame(id);
    }
    setRevealed(false);
    const t = setTimeout(() => setMounted(false), CURTAIN_DURATION_MS);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 border border-rose-900/40 bg-[#0f0a0f]/85 backdrop-blur-sm hover:bg-rose-950/30 transition-colors"
      >
        <span className="text-[10px] font-bold tracking-widest text-rose-300 uppercase">
          👣 Peek at Goddess&apos; feet
        </span>
        <span className="text-[10px] uppercase tracking-widest text-rose-400/70">
          {open ? "close" : "reveal"}
        </span>
      </button>

      {mounted && (
        <div
          className="relative overflow-hidden"
          style={{ height: REVEAL_HEIGHT }}
          aria-hidden={!revealed}
        >
          <div
            className="absolute inset-y-0 left-0 w-1/2 bg-[#0f0a0f]/85 backdrop-blur-sm border-l border-b border-rose-900/40 transition-transform ease-in-out"
            style={{
              transform: revealed ? "translateX(-100%)" : "translateX(0)",
              transitionDuration: `${CURTAIN_DURATION_MS}ms`,
            }}
          />
          <div
            className="absolute inset-y-0 right-0 w-1/2 bg-[#0f0a0f]/85 backdrop-blur-sm border-r border-b border-rose-900/40 transition-transform ease-in-out"
            style={{
              transform: revealed ? "translateX(100%)" : "translateX(0)",
              transitionDuration: `${CURTAIN_DURATION_MS}ms`,
            }}
          />
        </div>
      )}
    </div>
  );
}
