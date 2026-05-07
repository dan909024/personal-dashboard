"use server";

import { revalidatePath } from "next/cache";

import {
  appendDailyCheckIn,
  appendEdgeLog,
  appendOrgasmLog,
  appendSelfHelpLog,
  appendWorshipLog,
  setSetting,
  type OrgasmType,
} from "@/lib/sheets";
import { sendHarleyTelegram } from "@/lib/telegram";
import { getDashboardWeakness } from "@/lib/weakness";

const EDGE_TELEGRAM_THRESHOLD = 5;

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
  note?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { date, daysSincePrevious } = await appendOrgasmLog({ type, note });
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

