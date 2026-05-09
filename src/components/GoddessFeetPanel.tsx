"use client";

import { useState } from "react";

export function GoddessFeetPanel({ coachPhotoUrl }: { coachPhotoUrl: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-rose-900/40 bg-[#0f0a0f]/85 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-rose-950/20 transition-colors"
      >
        <span className="text-[10px] font-bold tracking-widest text-rose-300 uppercase">
          👣 Peek at Goddess&apos; feet
        </span>
        <span className="text-[10px] uppercase tracking-widest text-rose-400/70">
          {open ? "hide" : "reveal"}
        </span>
      </button>
      {open && (
        <div
          className="w-full bg-cover bg-bottom border-t border-rose-900/40"
          style={{
            backgroundImage: `url('${coachPhotoUrl}')`,
            height: 320,
          }}
          aria-label="Goddess' feet"
        />
      )}
    </div>
  );
}
