/**
 * POST /api/health/ingest
 *
 * Receives Apple Health snapshots from an iOS Shortcut. Posts are
 * idempotent: the same (Date, Source) combination upserts the latest
 * row in place. Steps are capped at 100k to absorb sensor glitches
 * (anything higher is almost certainly a bad reading rather than an
 * ultramarathon).
 *
 * Auth: Authorization: Bearer <APPLE_HEALTH_INGEST_SECRET>
 *
 * Payload:
 *   {
 *     date: "YYYY-MM-DD" (Sydney timezone),
 *     steps: number,
 *     workouts: [{ type, durationMin, strain?, source }],
 *     activeCalories?: number,
 *     restingCalories?: number,
 *     source: "ios-shortcut"
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appendAppleHealth,
  isConfigured,
  type AppleHealthRow,
  type AppleHealthWorkout,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEPS_CAP = 100000;
const CAL_CAP = 20000;
const WORKOUT_DURATION_CAP_MIN = 24 * 60;

function bad(msg: string, status = 400) {
  // 400s are usually the Shortcut sending the wrong shape (date format, missing
  // source, body wrapped in a string). Log the validation message so the next
  // failed attempt leaves a fingerprint in `vercel logs`.
  if (status === 400) console.warn("[health/ingest] 400:", msg);
  return NextResponse.json({ ok: false, error: msg }, { status });
}

function asNumber(v: unknown, fallback: number | undefined = undefined): number | undefined {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeWorkouts(raw: unknown): AppleHealthWorkout[] {
  if (!Array.isArray(raw)) return [];
  const out: AppleHealthWorkout[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const wo = w as Record<string, unknown>;
    const type = String(wo.type ?? "").trim();
    const durationMin = asNumber(wo.durationMin, 0) ?? 0;
    const source = String(wo.source ?? "").trim();
    if (!type || !source) continue;
    const strain = asNumber(wo.strain);
    out.push({
      type,
      durationMin: clamp(durationMin, 0, WORKOUT_DURATION_CAP_MIN),
      ...(strain !== undefined ? { strain } : {}),
      source,
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const secret = process.env.APPLE_HEALTH_INGEST_SECRET || "";
  if (!secret) return bad("APPLE_HEALTH_INGEST_SECRET not configured", 500);
  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (provided !== secret) return bad("unauthorized", 401);

  if (!isConfigured()) {
    return bad("dashboard sheet not configured", 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("invalid JSON body");
  }
  if (!body || typeof body !== "object") return bad("body must be a JSON object");
  const b = body as Record<string, unknown>;

  // Tolerate ISO-with-time strings ("2026-05-07T13:42:00+10:00", "2026-05-07Z",
  // "2026-05-07 13:42") by slicing the first 10 chars before validation.
  // iOS Shortcuts' "Format Date" can sneak a time component in even when set
  // to a date-only format. Locale formats like "07/05/2026" still 400 — those
  // are genuinely wrong-shape and the user should fix the Shortcut.
  const rawDate = String(b.date ?? "").trim();
  const date = rawDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.warn("[health/ingest] 400 raw date payload:", JSON.stringify(rawDate));
    return bad("date must be YYYY-MM-DD");
  }
  const source = String(b.source ?? "").trim();
  if (!source) return bad("source is required");

  const stepsRaw = asNumber(b.steps, 0) ?? 0;
  const steps = clamp(Math.round(stepsRaw), 0, STEPS_CAP);

  const activeCalRaw = asNumber(b.activeCalories);
  const restingCalRaw = asNumber(b.restingCalories);
  const activeCalories =
    activeCalRaw !== undefined ? clamp(Math.round(activeCalRaw), 0, CAL_CAP) : undefined;
  const restingCalories =
    restingCalRaw !== undefined ? clamp(Math.round(restingCalRaw), 0, CAL_CAP) : undefined;

  const workouts = normalizeWorkouts(b.workouts);

  const row: AppleHealthRow = {
    date,
    steps,
    workouts,
    activeCalories,
    restingCalories,
    source,
    syncedAt: new Date().toISOString(),
  };

  try {
    const result = await appendAppleHealth(row);
    return NextResponse.json({ ok: true, action: result.action, row });
  } catch (e) {
    console.error("[health/ingest] append failed:", (e as Error).message);
    return bad("sheet append failed", 500);
  }
}
