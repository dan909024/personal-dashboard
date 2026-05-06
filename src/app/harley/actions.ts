"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import {
  DENIAL_END_DATE_TAG,
  readDenialEndDate,
  setDenialEndDate,
  setSetting,
} from "@/lib/sheets";

function unauthorized(token: string): boolean {
  const expected = process.env.HARLEY_ADMIN_TOKEN || "";
  return !expected || token !== expected;
}

/**
 * Format a Date as ISO 8601 with the current Sydney offset:
 *   2026-05-20T23:59:00+10:00
 * Uses Intl to derive both wall-clock parts and the +HH:MM offset, so
 * AEST vs AEDT is handled automatically.
 */
function formatSydneyOffsetISO(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA returns hour "24" for midnight in some Node versions; coerce.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const datePart = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const tz = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00";
  return `${datePart}${tz.replace("GMT", "")}`;
}

function currentSydneyOffsetSuffix(): string {
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(new Date());
  const tz = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00";
  return tz.replace("GMT", "");
}

function revalidateAll() {
  revalidateTag(DENIAL_END_DATE_TAG);
  revalidatePath("/");
  revalidatePath("/harley");
}

export async function extendDenialAction(
  token: string,
  daysOffset: number
): Promise<
  { ok: true; newEndDate: string } | { ok: false; error: string }
> {
  if (unauthorized(token)) return { ok: false, error: "unauthorized" };
  if (!Number.isFinite(daysOffset) || daysOffset === 0) {
    return { ok: false, error: "invalid days" };
  }
  // Base from the current target if it's still future; otherwise from now.
  // That way "+3 days" extends an active denial, but if the date has lapsed
  // it starts a fresh 3-day window from this moment.
  const current = await readDenialEndDate();
  const nowMs = Date.now();
  let baseMs = nowMs;
  if (current) {
    const ms = Date.parse(current);
    if (!isNaN(ms) && ms > nowMs) baseMs = ms;
  }
  const newMs = baseMs + daysOffset * 86_400_000;
  const newEndDate = formatSydneyOffsetISO(new Date(newMs));
  try {
    await setDenialEndDate(newEndDate);
    revalidateAll();
    return { ok: true, newEndDate };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setDenialDateAction(
  token: string,
  isoLocal: string
): Promise<{ ok: true; newEndDate: string } | { ok: false; error: string }> {
  if (unauthorized(token)) return { ok: false, error: "unauthorized" };
  // datetime-local format: YYYY-MM-DDTHH:MM (no TZ, no seconds)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(isoLocal)) {
    return { ok: false, error: "invalid format" };
  }
  // Treat the wall-clock value as Sydney time. Stamp the current Sydney
  // offset so Date.parse roundtrips to the same wall moment.
  const newEndDate = `${isoLocal}:00${currentSydneyOffsetSuffix()}`;
  try {
    await setDenialEndDate(newEndDate);
    revalidateAll();
    return { ok: true, newEndDate };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function clearDenialAction(
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (unauthorized(token)) return { ok: false, error: "unauthorized" };
  try {
    await setDenialEndDate("");
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setOrgasmAllowedAdminAction(
  token: string,
  value: "yes" | "no"
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (unauthorized(token)) return { ok: false, error: "unauthorized" };
  if (value !== "yes" && value !== "no") {
    return { ok: false, error: "invalid value" };
  }
  try {
    await setSetting("orgasm_allowed", value, "harley-admin");
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
