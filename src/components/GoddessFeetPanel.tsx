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
        className="w-full flex items-center justify-between px-4 py-3 border border-bloom-800/60 bg-iron-700/85 backdrop-blur-sm hover:bg-bloom-900/30 transition-colors"
      >
        <span className="brand-serif text-[12px] font-semibold tracking-[0.22em] text-bloom-200 uppercase">
          👣 Peek at Goddess&apos; feet
        </span>
        <span className="text-[10px] uppercase tracking-widest text-bloom-300/70">
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
            className="absolute inset-y-0 left-0 w-1/2 bg-iron-700/85 backdrop-blur-sm border-l border-b border-bloom-800/60 transition-transform ease-in-out"
            style={{
              transform: revealed ? "translateX(-100%)" : "translateX(0)",
              transitionDuration: `${CURTAIN_DURATION_MS}ms`,
            }}
          />
          <div
            className="absolute inset-y-0 right-0 w-1/2 bg-iron-700/85 backdrop-blur-sm border-r border-b border-bloom-800/60 transition-transform ease-in-out"
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
