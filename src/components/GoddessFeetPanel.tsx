"use client";

import { useEffect, useState } from "react";

const CURTAIN_DURATION_MS = 800;
const DEFAULT_IMAGE = "/backgrounds/denied.jpg";

type Props = {
  /** Photo revealed when the curtains open. Defaults to the foot photo. */
  imageSrc?: string;
};

/**
 * Click "Peek at Goddess' feet" → the entire page splits open.
 * Two curtains animate from covering the viewport to sliding off-screen,
 * revealing the photo behind. Click anywhere or the close button to
 * pull the curtains back.
 */
export function GoddessFeetPanel({ imageSrc = DEFAULT_IMAGE }: Props) {
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

  // Lock scroll while the reveal is open so it feels like a page-wide moment.
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // Esc to close.
  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mounted]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 border border-bloom-800/60 bg-iron-700/85 backdrop-blur-sm hover:bg-bloom-900/30 transition-colors"
      >
        <span className="brand-serif text-[12px] font-semibold tracking-[0.22em] text-bloom-200 uppercase">
          👣 Peek at Goddess&apos; feet
        </span>
        <span className="text-[10px] uppercase tracking-widest text-bloom-300/70">
          reveal
        </span>
      </button>

      {mounted && (
        <div
          className="fixed inset-0 z-[60] overflow-hidden cursor-pointer"
          onClick={() => setOpen(false)}
          aria-hidden={!revealed}
          role="dialog"
          aria-label="Goddess reveal"
        >
          {/* The photo backdrop — what's behind the curtains. */}
          <div
            className="absolute inset-0 bg-center bg-cover bg-no-repeat"
            style={{ backgroundImage: `url('${imageSrc}')` }}
          />
          {/* Soft inky vignette so edges feel theatrical, not flat. */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 0%, transparent 50%, rgba(6,8,12,0.55) 100%)",
            }}
          />

          {/* Left curtain — covers left half when closed, slides off-screen when revealed. */}
          <div
            className="absolute inset-y-0 left-0 w-1/2 bg-iron backdrop-blur-md transition-transform ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              transform: revealed ? "translateX(-100%)" : "translateX(0)",
              transitionDuration: `${CURTAIN_DURATION_MS}ms`,
              boxShadow:
                "inset -16px 0 32px -16px rgba(0,0,0,0.6), 16px 0 32px -16px rgba(217,117,143,0.25)",
            }}
          />
          {/* Right curtain. */}
          <div
            className="absolute inset-y-0 right-0 w-1/2 bg-iron backdrop-blur-md transition-transform ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              transform: revealed ? "translateX(100%)" : "translateX(0)",
              transitionDuration: `${CURTAIN_DURATION_MS}ms`,
              boxShadow:
                "inset 16px 0 32px -16px rgba(0,0,0,0.6), -16px 0 32px -16px rgba(217,117,143,0.25)",
            }}
          />

          {/* Close affordance — top-right, doesn't bubble click to the dialog backdrop. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            aria-label="Close"
            className="absolute top-4 right-4 z-10 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-ivory-100 bg-ink-deep/70 border border-ivory/20 hover:border-bloom-300 hover:bg-ink-deep/90 transition-colors"
            style={{
              opacity: revealed ? 1 : 0,
              transitionProperty: "opacity",
              transitionDuration: `${CURTAIN_DURATION_MS}ms`,
              transitionDelay: revealed ? `${CURTAIN_DURATION_MS / 2}ms` : "0ms",
            }}
          >
            Close
          </button>
        </div>
      )}
    </>
  );
}
