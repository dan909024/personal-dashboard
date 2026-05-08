"use server";

import { cookies } from "next/headers";
import { revalidatePath, revalidateTag } from "next/cache";
import {
  DENIAL_END_DATE_TAG,
  appendPunishment,
  markAllUnpaidPaid,
  markPunishmentPaid,
  readDenialEndDate,
  setDenialEndDate,
  setSetting,
  voidPunishment,
} from "@/lib/sheets";
import { HARLEY_RULES, type HarleyRuleId } from "@/lib/harley-rules";
import { verifyJWT } from "@/lib/jwt";
import { sendDanTelegram } from "@/lib/telegram";

async function authorized(): Promise<boolean> {
  const c = await cookies();
  const cookie = c.get("harley_session");
  if (!cookie) return false;
  const secret = process.env.HARLEY_JWT_SECRET || "";
  if (!secret) return false;
  const v = verifyJWT(cookie.value, secret);
  return v.ok && v.payload.sub === "harley";
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
  hoursOffset: number
): Promise<
  { ok: true; newEndDate: string } | { ok: false; error: string }
> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Number.isFinite(hoursOffset) || hoursOffset === 0) {
    return { ok: false, error: "invalid hours" };
  }
  // Base from the current target if it's still future; otherwise from now.
  // That way "+3 days" extends an active denial, but if the date has lapsed
  // it starts a fresh window from this moment.
  const current = await readDenialEndDate();
  const nowMs = Date.now();
  let baseMs = nowMs;
  if (current) {
    const ms = Date.parse(current);
    if (!isNaN(ms) && ms > nowMs) baseMs = ms;
  }
  const newMs = baseMs + hoursOffset * 3_600_000;
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
  isoLocal: string
): Promise<{ ok: true; newEndDate: string } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
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

export async function clearDenialAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  try {
    await setDenialEndDate("");
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setOrgasmAllowedAdminAction(
  value: "yes" | "no"
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
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

// ---------- Fines ----------

export async function addFineAction(
  amount: number,
  reason: string,
  ruleId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "amount must be > 0" };
  }
  // Cap absurd amounts to avoid fat-finger ($1m on a phone). Daniel can
  // raise this if he ever needs to.
  if (amount > 100_000) {
    return { ok: false, error: "amount too large" };
  }
  const trimmedReason = reason.trim().slice(0, 200);
  const validRuleId =
    ruleId && Object.prototype.hasOwnProperty.call(HARLEY_RULES, ruleId)
      ? (ruleId as HarleyRuleId)
      : "";
  try {
    await appendPunishment({
      amount,
      reason: trimmedReason || "Manual fine",
      setBy: "Harley (panel)",
      ruleId: validRuleId,
    });
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function markFinePaidAction(
  rowIndex: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return { ok: false, error: "invalid row" };
  }
  try {
    await markPunishmentPaid(rowIndex);
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function voidFineAction(
  rowIndex: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return { ok: false, error: "invalid row" };
  }
  try {
    await voidPunishment(rowIndex);
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function clearAllUnpaidFinesAction(): Promise<
  { ok: true; cleared: number } | { ok: false; error: string }
> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  try {
    const cleared = await markAllUnpaidPaid();
    revalidateAll();
    return { ok: true, cleared };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setDoubleNextMonthAction(
  enabled: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  try {
    await setSetting("double_next_month", enabled ? "yes" : "no", "harley-admin");
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- Communications ----------

/**
 * Push a message to Daniel's Telegram from the Goddess panel. Prefixes
 * with "🩷 Goddess:" so Daniel sees the source at a glance regardless
 * of free-text content. Skips silently when bot/chat env is missing.
 */
export async function messageDanielAction(
  body: string
): Promise<{ ok: true; sent: boolean } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  const text = body.trim().slice(0, 4000);
  if (!text) return { ok: false, error: "empty message" };
  try {
    const result = await sendDanTelegram(`🩷 Goddess:\n${text}`);
    return { ok: true, sent: result.sent };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
