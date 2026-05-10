"use server";

import { revalidatePath } from "next/cache";

import {
  appendDailyCheckIn,
  appendEdgeLog,
  appendOrgasmLog,
  appendPunishment,
  appendSelfHelpLog,
  appendWorshipLog,
  setDenialEndDate,
  setSetting,
  type OrgasmType,
} from "@/lib/sheets";
import { SLIP_FINE_AMOUNT } from "@/lib/harley-rules";
import { sendHarleyTelegram } from "@/lib/telegram";
import { getDashboardWeakness } from "@/lib/weakness";

const EDGE_TELEGRAM_THRESHOLD = 5;
const DENIAL_RESET_DAYS = 30;

// Format a UTC instant as a Sydney-offset ISO string, e.g.
// "2026-05-09T17:00:00+10:00". Picks the offset valid for that exact
// moment so AEST↔AEDT boundaries are handled.
function formatSydneyOffsetISO(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const datePart = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const tz = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00";
  return `${datePart}${tz.replace("GMT", "")}`;
}

// Convert a Sydney wall-clock {date, time} pair to a UTC Date instant,
// honouring DST for that exact moment. Returns now if no backdate.
function slipMomentUtc(backdate: { date: string; time: string } | undefined): Date {
  if (!backdate) return new Date();
  // Two-step: parse with +10:00 to get an approximate UTC moment,
  // then re-derive the actual Sydney offset for that moment, then
  // re-parse with the correct offset. The two-step is needed because
  // a backdate near a DST boundary could otherwise be off by an hour.
  const approx = new Date(Date.parse(`${backdate.date}T${backdate.time}:00+10:00`));
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(approx);
  const tz = (tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00").replace("GMT", "");
  return new Date(Date.parse(`${backdate.date}T${backdate.time}:00${tz}`));
}

export async function setOrgasmAllowedAction(
  value: "yes" | "no"
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (value !== "yes" && value !== "no") {
    return { ok: false, error: "value must be yes or no" };
  }
  try {
    await setSetting("orgasm_allowed", value, "dashboard-toggle");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    console.error("[setOrgasmAllowedAction]", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

export async function logOrgasmAction(
  type: OrgasmType,
  note?: string,
  backdate?: { date: string; time: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Validate backdate format strictly so a typo doesn't silently
    // write a row with a garbage timestamp.
    if (backdate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(backdate.date)) {
        return { ok: false, error: "backdate.date must be YYYY-MM-DD" };
      }
      if (!/^\d{2}:\d{2}$/.test(backdate.time)) {
        return { ok: false, error: "backdate.time must be HH:MM (24h)" };
      }
    }
    const { date, daysSincePrevious } = await appendOrgasmLog({
      type,
      note,
      date: backdate?.date,
      time: backdate?.time,
    });

    // A "lapsed" log is a self-reported slip — auto-fine $20 to the
    // Punishments tab. ruleId="slip" so the OWED HARLEY tooltip shows
    // the rule provenance instead of "Manual fine".
    let finedAmount = 0;
    let denialResetTo: string | null = null;
    if (type === "lapsed") {
      try {
        await appendPunishment({
          amount: SLIP_FINE_AMOUNT,
          reason: "Cumming without permission",
          setBy: "auto (slip button)",
          ruleId: "slip",
          date,
        });
        finedAmount = SLIP_FINE_AMOUNT;
      } catch (fineErr) {
        // Don't fail the whole action if the fine append fails — the
        // orgasm log already wrote successfully and Harley still gets
        // the Telegram. Surface the error in logs so we can chase it.
        console.error(
          "[logOrgasmAction] slip fine append failed:",
          (fineErr as Error).message
        );
      }

      // Reset the 30-day denial countdown. denial_started_at = slip
      // moment; denial_end_date = slip moment + 30 days. Both stamped
      // with Sydney offset so the DenialClock parses correctly.
      try {
        const slipUtc = slipMomentUtc(backdate);
        const endUtc = new Date(slipUtc.getTime() + DENIAL_RESET_DAYS * 86_400_000);
        const slipIso = formatSydneyOffsetISO(slipUtc);
        const endIso = formatSydneyOffsetISO(endUtc);
        await setDenialEndDate(endIso);
        await setSetting("denial_started_at", slipIso, "auto (slip button)");
        denialResetTo = endIso;
      } catch (denialErr) {
        console.error(
          "[logOrgasmAction] denial reset failed:",
          (denialErr as Error).message
        );
      }
    }

    // Pull the freshest dashboard state so the message reflects post-write reality.
    const dash = await getDashboardWeakness();
    const lines = [
      `Dan reported: ${type}`,
      `Time: ${date} ${new Date().toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Sydney" })} Sydney`,
      `Days since previous: ${daysSincePrevious === null ? "(first)" : daysSincePrevious}`,
      `Days denied: ${dash.daysDenied}`,
      `Edges since last: ${dash.totalEdgesSinceLast}`,
      `Phase: ${dash.currentPhase.name}`,
      `"${dash.currentPhase.flavorText}"`,
      `Weakness score: ${dash.weaknessScore}`,
    ];
    if (finedAmount > 0) lines.push(`Auto-fine: $${finedAmount} → Punishments`);
    if (denialResetTo) lines.push(`Denial timer reset: ${DENIAL_RESET_DAYS}d → ${denialResetTo}`);
    if (note) lines.push(`Note: ${note}`);
    await sendHarleyTelegram(lines.join("\n"));
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    console.error("[logOrgasmAction]", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

export async function logEdgeAction(
  note?: string
): Promise<{ ok: true; countToday: number } | { ok: false; error: string }> {
  try {
    const { countToday } = await appendEdgeLog({ note });
    if (countToday >= EDGE_TELEGRAM_THRESHOLD) {
      // Pull dashboard data so Harley sees the brutal multiplier in real time.
      // Use Telegram (not email) for per-edge fan-out — orgasm logs are rare
      // and stay on email; per-edge alerts during a marathon would otherwise
      // spam Harley's inbox.
      const dash = await getDashboardWeakness();
      const lines = [
        `Edge #${countToday} today (Sydney time).`,
        `Cumulative since last orgasm: ${dash.totalEdgesSinceLast}`,
        `Brutal multiplier: ×${dash.todayBrutalMultiplier.toFixed(2)}`,
        `Today's gain so far: +${dash.todayDailyGain}`,
        `Phase: ${dash.currentPhase.name}`,
        `Weakness score: ${dash.weaknessScore}`,
      ];
      if (note) lines.push(`Note: ${note}`);
      await sendHarleyTelegram(lines.join("\n"));
    }
    revalidatePath("/");
    return { ok: true, countToday };
  } catch (e) {
    console.error("[logEdgeAction]", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

export async function logDailyCheckInAction(
  arousal: number,
  note?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const clamped = Math.max(1, Math.min(10, Math.round(arousal)));
    await appendDailyCheckIn({ arousal: clamped, note });
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    console.error("[logDailyCheckInAction]", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

export async function logWorshipAction(
  activity: string,
  minutes: number,
  note?: string
): Promise<{ ok: true; minutes: number } | { ok: false; error: string }> {
  try {
    const trimmedActivity = (activity || "").trim();
    if (!trimmedActivity) {
      return { ok: false, error: "activity is required" };
    }
    const clamped = Math.max(1, Math.min(600, Math.round(minutes)));
    await appendWorshipLog({ activity: trimmedActivity, minutes: clamped, note });
    revalidatePath("/");
    return { ok: true, minutes: clamped };
  } catch (e) {
    console.error("[logWorshipAction]", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

export async function logSelfHelpAction(
  activity: string,
  minutes: number,
  note?: string
): Promise<{ ok: true; minutes: number } | { ok: false; error: string }> {
  try {
    const trimmedActivity = (activity || "").trim();
    if (!trimmedActivity) {
      return { ok: false, error: "activity is required" };
    }
    const clamped = Math.max(1, Math.min(600, Math.round(minutes)));
    await appendSelfHelpLog({ activity: trimmedActivity, minutes: clamped, note });
    revalidatePath("/");
    return { ok: true, minutes: clamped };
  } catch (e) {
    console.error("[logSelfHelpAction]", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

