"use server";

import { cookies } from "next/headers";
import { revalidatePath, revalidateTag } from "next/cache";
import {
  DENIAL_END_DATE_TAG,
  appendGoddessAudit,
  appendPunishment,
  getSetting,
  markAllUnpaidPaid,
  markPunishmentPaid,
  readDenialEndDate,
  setDenialEndDate,
  setSetting,
  todaySydneyISO,
  voidPunishment,
} from "@/lib/sheets";
import {
  createHarleyCalendarEvent,
  isCalendarConfigured,
} from "@/lib/calendar";
import {
  DEFAULT_FINE_AMOUNTS,
  HARLEY_RULES,
  fineAmountSettingKey,
  type HarleyRuleId,
} from "@/lib/harley-rules";
import {
  EDGES_DAILY_TARGET_KEY,
  LAST_SUNDAY_REVIEW_KEY,
  WORSHIP_DAILY_TARGET_MIN_KEY,
  currentOrPreviousSundayISO,
} from "@/lib/rule-eval";
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
    await appendGoddessAudit("extend", `+${hoursOffset}h → ${newEndDate}`);
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
    await appendGoddessAudit("set-date", newEndDate);
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
    await appendGoddessAudit("clear-target", "");
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
    // Stamp denial_started_at on the yes→no transition so the panel
    // can show a "denied for N days" counter. We only stamp on the
    // transition (not on every "no" write) so the counter accurately
    // reflects when this denial run actually started.
    if (value === "no") {
      const prev = String(
        ((await getSetting("orgasm_allowed")) ?? "")
      ).trim().toLowerCase();
      if (prev !== "no") {
        await setSetting(
          "denial_started_at",
          new Date().toISOString(),
          "harley-admin"
        );
      }
    }
    await setSetting("orgasm_allowed", value, "harley-admin");
    await appendGoddessAudit(
      value === "yes" ? "allow" : "deny",
      ""
    );
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
): Promise<
  { ok: true; finalAmount: number; doubled: boolean } | { ok: false; error: string }
> {
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
  // Hard-mode doubles every manual fine until disabled.
  const hardMode =
    String((await getSetting("hard_mode")) ?? "")
      .trim()
      .toLowerCase() === "yes";
  const finalAmount = hardMode ? amount * 2 : amount;
  const finalReason = hardMode
    ? `${trimmedReason || "Manual fine"} (hard-mode 2×)`
    : trimmedReason || "Manual fine";
  try {
    await appendPunishment({
      amount: finalAmount,
      reason: finalReason,
      setBy: "Harley (panel)",
      ruleId: validRuleId,
    });
    await appendGoddessAudit(
      "fine",
      `$${finalAmount}${hardMode ? " (2×)" : ""} · ${finalReason}`
    );
    revalidateAll();
    return { ok: true, finalAmount, doubled: hardMode };
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
    await appendGoddessAudit("mark-paid", `row ${rowIndex}`);
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
    await appendGoddessAudit("void-fine", `row ${rowIndex}`);
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
    await appendGoddessAudit("reset-balance", `${cleared} row(s)`);
    revalidateAll();
    return { ok: true, cleared };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setWorshipTargetAction(
  minutes: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { ok: false, error: "minutes must be ≥ 0" };
  }
  // 24 hr cap — anything higher is a fat-finger.
  if (minutes > 24 * 60) {
    return { ok: false, error: "minutes too large" };
  }
  const rounded = Math.round(minutes);
  try {
    await setSetting(WORSHIP_DAILY_TARGET_MIN_KEY, rounded, "harley-admin");
    await appendGoddessAudit("set-worship-target", `${rounded} min/day`);
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setEdgesTargetAction(
  count: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Number.isFinite(count) || count < 0) {
    return { ok: false, error: "count must be ≥ 0" };
  }
  if (count > 100) {
    return { ok: false, error: "count too large" };
  }
  const rounded = Math.round(count);
  try {
    await setSetting(EDGES_DAILY_TARGET_KEY, rounded, "harley-admin");
    await appendGoddessAudit("set-edges-target", `${rounded}/day`);
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setFineAmountAction(
  ruleId: string,
  amount: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!Object.prototype.hasOwnProperty.call(HARLEY_RULES, ruleId)) {
    return { ok: false, error: "unknown rule" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "amount must be > 0" };
  }
  // Same fat-finger guard as addFineAction.
  if (amount > 100_000) {
    return { ok: false, error: "amount too large" };
  }
  const rounded = Math.round(amount);
  try {
    await setSetting(
      fineAmountSettingKey(ruleId as HarleyRuleId),
      rounded,
      "harley-admin"
    );
    await appendGoddessAudit(
      "set-fine-amount",
      `${ruleId} → $${rounded}`
    );
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function setHardModeAction(
  enabled: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  try {
    await setSetting("hard_mode", enabled ? "yes" : "no", "harley-admin");
    await appendGoddessAudit("hard-mode", enabled ? "ON" : "OFF");
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Log a "drank alcohol" event from the Goddess panel button. Appends a
 * Punishments row stamped with rule_id=drinking at the rule's live fine
 * amount. The drinking rule is manual-only — no auto-eval — so this
 * action and the Telegram /drank command are the only ways for it to fire.
 */
export async function logDrinkAction(): Promise<
  { ok: true; finalAmount: number; doubled: boolean } | { ok: false; error: string }
> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  try {
    const amountRaw = await getSetting(fineAmountSettingKey("drinking"));
    const parsed = Number(amountRaw);
    const fineAmount =
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FINE_AMOUNTS.drinking;
    const hardMode =
      String((await getSetting("hard_mode")) ?? "")
        .trim()
        .toLowerCase() === "yes";
    const finalAmount = hardMode ? fineAmount * 2 : fineAmount;
    await appendPunishment({
      amount: finalAmount,
      reason: hardMode ? "Drank alcohol (hard-mode 2×)" : "Drank alcohol",
      setBy: "Harley (panel)",
      ruleId: "drinking",
    });
    await appendGoddessAudit(
      "drank",
      `$${finalAmount}${hardMode ? " (2×)" : ""}`
    );
    revalidateAll();
    return { ok: true, finalAmount, doubled: hardMode };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Stamp `last_sunday_review_date` with the current-or-previous Sunday's date,
 * marking that Daniel did the Sunday review. Both this action and the
 * Telegram /review command write the same Settings key, and rule-eval reads
 * it before deciding whether to fine for the most-recent past Sunday.
 */
export async function logSundayReviewAction(): Promise<
  { ok: true; sundayDate: string } | { ok: false; error: string }
> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  try {
    const sunday = currentOrPreviousSundayISO(todaySydneyISO());
    await setSetting(LAST_SUNDAY_REVIEW_KEY, sunday, "harley-admin");
    await appendGoddessAudit("review-stamped", sunday);
    revalidateAll();
    return { ok: true, sundayDate: sunday };
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
    await appendGoddessAudit(
      "message-daniel",
      `${result.sent ? "sent" : "skipped"}: ${text.slice(0, 80)}`
    );
    revalidateAll();
    return { ok: true, sent: result.sent };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- Calendar tasks ----------

export async function addCalendarTaskAction(
  summary: string,
  whenLocal: string
): Promise<
  { ok: true; eventId: string; htmlLink: string | null }
  | { ok: false; error: string }
> {
  if (!(await authorized())) return { ok: false, error: "unauthorized" };
  if (!isCalendarConfigured()) {
    return { ok: false, error: "calendar not configured" };
  }
  const trimmed = summary.trim().slice(0, 200);
  if (!trimmed) return { ok: false, error: "empty summary" };
  // datetime-local input format YYYY-MM-DDTHH:MM. Stamp with the current
  // Sydney offset so Google interprets the wall-clock as Sydney-local.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(whenLocal)) {
    return { ok: false, error: "invalid datetime" };
  }
  const startISO = `${whenLocal}:00${currentSydneyOffsetSuffix()}`;
  try {
    const res = await createHarleyCalendarEvent({
      summary: trimmed,
      startISO,
    });
    await appendGoddessAudit(
      "add-calendar-task",
      `${trimmed} @ ${startISO}`
    );
    revalidateAll();
    return { ok: true, eventId: res.eventId, htmlLink: res.htmlLink };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
