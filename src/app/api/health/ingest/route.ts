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
 *     water?: number   // milliliters; the Auto Export Shortcut maps
 *                      // HealthKit dietaryWater (incl. Ladder) → ml.
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
const WATER_ML_CAP = 15000;
const PROTEIN_G_CAP = 800;
const CALORIES_CONSUMED_CAP = 15000;

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

/**
 * Sum a list of HealthKit-style samples into a single number. Tolerates
 * the shapes the iOS Shortcuts app might serialize when the user binds
 * a "Filter Health Samples" output directly into a JSON Array/Text field
 * (because their Shortcuts version is missing the Statistics action):
 *   - [47, 32, 11]                   → array of numbers
 *   - [{quantity: 47}, ...]          → records with .quantity / .value / .count
 *   - "47 count, 32 count"           → comma-separated text with units stripped
 *   - "47.5"                          → single number as text
 * Returns undefined when the input isn't a usable list.
 */
function sumSamples(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    if (parts.length === 0) return undefined;
    let total = 0; let any = false;
    for (const p of parts) {
      const n = Number(p);
      if (Number.isFinite(n)) { total += n; any = true; }
    }
    return any ? total : undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  let total = 0; let any = false;
  for (const item of raw) {
    const n = sampleQuantity(item);
    if (n !== undefined) { total += n; any = true; }
  }
  return any ? total : undefined;
}

function sampleQuantity(item: unknown): number | undefined {
  if (typeof item === "number" && Number.isFinite(item)) return item;
  if (typeof item === "string") {
    const m = item.match(/^[\s]*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const key of ["quantity", "value", "count", "amount"]) {
      const v = o[key];
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
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

  // Accept each metric as EITHER a single pre-summed number OR a raw
  // list of HealthKit samples that we sum server-side. The list path is
  // for iOS Shortcuts versions where "Statistics on Health Samples" is
  // missing — the user binds the Filter output directly to *Samples.
  const stepsRaw = asNumber(b.steps) ?? sumSamples(b.stepSamples) ?? 0;
  const steps = clamp(Math.round(stepsRaw), 0, STEPS_CAP);

  const activeCalRaw = asNumber(b.activeCalories) ?? sumSamples(b.activeCalorieSamples);
  const restingCalRaw = asNumber(b.restingCalories) ?? sumSamples(b.restingCalorieSamples);
  const activeCalories =
    activeCalRaw !== undefined ? clamp(Math.round(activeCalRaw), 0, CAL_CAP) : undefined;
  const restingCalories =
    restingCalRaw !== undefined ? clamp(Math.round(restingCalRaw), 0, CAL_CAP) : undefined;

  const workouts = normalizeWorkouts(b.workouts);

  // Water in milliliters (or liters auto-detected if <50).
  const waterRaw = asNumber(b.water) ?? sumSamples(b.waterSamples);
  let waterMl: number | undefined;
  if (waterRaw !== undefined && waterRaw > 0) {
    const asMl = waterRaw < 50 ? waterRaw * 1000 : waterRaw;
    waterMl = clamp(Math.round(asMl), 0, WATER_ML_CAP);
  }

  // Protein in grams (HealthKit dietaryProtein).
  const proteinRaw = asNumber(b.protein) ?? sumSamples(b.proteinSamples);
  const proteinG =
    proteinRaw !== undefined && proteinRaw > 0
      ? clamp(Math.round(proteinRaw), 0, PROTEIN_G_CAP)
      : undefined;

  // Calories consumed in kcal (HealthKit dietaryEnergyConsumed).
  // Distinct from activeCalories (energy burned, ring 2).
  const consumedRaw =
    asNumber(b.caloriesConsumed) ??
    asNumber(b.dietaryEnergy) ??
    sumSamples(b.caloriesConsumedSamples) ??
    sumSamples(b.dietaryEnergySamples);
  const caloriesConsumed =
    consumedRaw !== undefined && consumedRaw > 0
      ? clamp(Math.round(consumedRaw), 0, CALORIES_CONSUMED_CAP)
      : undefined;

  const row: AppleHealthRow = {
    date,
    steps,
    workouts,
    activeCalories,
    restingCalories,
    source,
    syncedAt: new Date().toISOString(),
    ...(waterMl !== undefined ? { waterMl } : {}),
    ...(proteinG !== undefined ? { proteinG } : {}),
    ...(caloriesConsumed !== undefined ? { caloriesConsumed } : {}),
  };

  try {
    const result = await appendAppleHealth(row);
    return NextResponse.json({ ok: true, action: result.action, row });
  } catch (e) {
    console.error("[health/ingest] append failed:", (e as Error).message);
    return bad("sheet append failed", 500);
  }
}
