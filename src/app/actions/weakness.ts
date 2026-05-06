"use server";

import { revalidatePath } from "next/cache";

import {
  appendDailyCheckIn,
  appendEdgeLog,
  appendOrgasmLog,
  type OrgasmType,
} from "@/lib/sheets";
import { sendHarleyEmail } from "@/lib/email";
import { getDashboardWeakness } from "@/lib/weakness";

const EDGE_EMAIL_THRESHOLD = 5;

export async function logOrgasmAction(
  type: OrgasmType,
  note?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { date, daysSincePrevious } = await appendOrgasmLog({ type, note });
    // Pull the freshest dashboard state so the email reflects post-write reality.
    const dash = await getDashboardWeakness();
    const subject = `[Dashboard] Dan reported: ${type}`;
    const lines = [
      `Time: ${date} ${new Date().toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Sydney" })} Sydney`,
      `Type: ${type}`,
      `Days since previous: ${daysSincePrevious === null ? "(first)" : daysSincePrevious}`,
      `Days denied: ${dash.daysDenied}`,
      `Edges since last: ${dash.totalEdgesSinceLast}`,
      `Phase: ${dash.currentPhase.name}`,
      `Flavor: ${dash.currentPhase.flavorText}`,
      `Weakness score: ${dash.weaknessScore}`,
    ];
    if (note) lines.push(`Note: ${note}`);
    const text = lines.join("\n");
    const html = `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
    await sendHarleyEmail(subject, html, text);
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
    if (countToday >= EDGE_EMAIL_THRESHOLD) {
      // Pull dashboard data so Harley sees the brutal multiplier in real time.
      const dash = await getDashboardWeakness();
      const subject = `[Dashboard] Dan logged edge ${countToday} today`;
      const lines = [
        `Edge #${countToday} today (Sydney time).`,
        `Cumulative since last orgasm: ${dash.totalEdgesSinceLast}`,
        `Brutal multiplier: ×${dash.todayBrutalMultiplier.toFixed(2)}`,
        `Today's gain so far: +${dash.todayDailyGain}`,
        `Phase: ${dash.currentPhase.name}`,
        `Weakness score: ${dash.weaknessScore}`,
      ];
      if (note) lines.push(`Note: ${note}`);
      const text = lines.join("\n");
      const html = `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
      await sendHarleyEmail(subject, html, text);
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
