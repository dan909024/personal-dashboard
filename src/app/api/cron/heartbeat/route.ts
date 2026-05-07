/**
 * Heartbeat cron — runs every 5 minutes. Verifies that the dashboard's
 * data plumbing is healthy and surfaces failures both in-tab (System
 * Health row) and out-of-band (HEAD ping to a Healthchecks-style URL,
 * email alert to Harley).
 *
 * Status checks:
 *   - Sheets configured (env vars present)
 *   - Whoop tokens stored
 *   - Most recent Whoop Daily row is no more than 36h old
 *
 * Alert dedupe: if anything is broken AND we haven't sent an alert in
 * the last 6 hours, send one. We track previous alerts via a marker
 * "ALERT_SENT@<iso>" embedded in the Notes column of System Health
 * rows — no extra column needed and the dedupe survives cold starts.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getLatestWhoopDaily,
  getWhoopTokens,
  isConfigured,
  appendSystemHealth,
  getSystemHealthHistory,
  getRecentSleepEdits,
} from "@/lib/sheets";
import { sendHarleyTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000; // 6h
const WHOOP_STALE_MS = 36 * 60 * 60 * 1000; // 36h

function unauthorized(reason: string) {
  return NextResponse.json({ ok: false, error: reason }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }
  const auth = req.headers.get("authorization") || "";
  const queryParam = new URL(req.url).searchParams.get("secret") || "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : queryParam;
  if (provided !== secret) return unauthorized("bad cron secret");

  const now = new Date();
  const nowIso = now.toISOString();

  const sheetsOk = isConfigured();

  // Pull data in parallel; degrade per-source rather than failing the whole tick.
  const [latestWhoop, tokens, sleepEdits] = await Promise.all([
    sheetsOk ? getLatestWhoopDaily().catch(() => null) : Promise.resolve(null),
    sheetsOk ? getWhoopTokens().catch(() => null) : Promise.resolve(null),
    sheetsOk ? getRecentSleepEdits(50).catch(() => []) : Promise.resolve([]),
  ]);

  const hasTokens = Boolean(tokens?.accessToken && tokens?.refreshToken);
  const lastWhoopSync = latestWhoop?.date || "";
  const lastWhoopMs = latestWhoopAgeMs(lastWhoopSync, now);
  const whoopFresh = lastWhoopMs !== null && lastWhoopMs <= WHOOP_STALE_MS;
  const whoopOk = sheetsOk && hasTokens && whoopFresh;

  const recentEditsCount = sleepEdits.filter((e) =>
    isWithin24h(e.detectedAt, now)
  ).length;

  const failureReasons: string[] = [];
  if (!sheetsOk) failureReasons.push("sheets_not_configured");
  if (sheetsOk && !hasTokens) failureReasons.push("whoop_not_connected");
  if (sheetsOk && hasTokens && !whoopFresh)
    failureReasons.push(
      lastWhoopSync ? `whoop_stale_${Math.round((lastWhoopMs ?? 0) / 3600000)}h` : "whoop_no_rows"
    );

  const heartbeatOk = failureReasons.length === 0;
  const notes = heartbeatOk
    ? "ok"
    : `failures: ${failureReasons.join(", ")}`;

  // Append the heartbeat row first — even if alerting/healthcheck fails,
  // we want a record of the tick.
  const status = {
    timestamp: nowIso,
    heartbeatOk,
    whoopOk,
    lastWhoopSync,
    recentSleepEdits: recentEditsCount,
    notes,
  };
  if (sheetsOk) {
    try {
      await appendSystemHealth(status);
    } catch (e) {
      console.error("[heartbeat] failed to append System Health row:", (e as Error).message);
    }
  }

  // Healthcheck ping (HEAD; ignore failures so it can't break the tick).
  const healthcheckUrl = process.env.HEALTHCHECK_HEARTBEAT_URL || "";
  if (heartbeatOk && healthcheckUrl) {
    try {
      await fetch(healthcheckUrl, { method: "HEAD", cache: "no-store" });
    } catch (e) {
      console.warn("[heartbeat] healthcheck ping failed:", (e as Error).message);
    }
  }

  // Email alert (only when broken AND we haven't alerted in the last 6h).
  let alertSent = false;
  let alertReason: string | undefined;
  if (!heartbeatOk && sheetsOk) {
    const lastAlertMs = await lastAlertTimestamp().catch(() => 0);
    if (now.getTime() - lastAlertMs > ALERT_DEDUPE_MS) {
      const text = [
        `Dashboard alert: ${failureReasons[0]}`,
        `Time: ${nowIso}`,
        `Heartbeat OK: ${heartbeatOk}`,
        `Whoop OK: ${whoopOk}`,
        `Last Whoop sync: ${lastWhoopSync || "(none)"}`,
        `Whoop age (h): ${lastWhoopMs !== null ? Math.round(lastWhoopMs / 3600000) : "n/a"}`,
        `Sleep edits 24h: ${recentEditsCount}`,
        `Failures: ${failureReasons.join(", ")}`,
      ].join("\n");
      const result = await sendHarleyTelegram(text);
      alertSent = result.sent;
      if (!result.sent) alertReason = result.reason;
      // Mark the alert in a follow-up System Health row so dedupe
      // survives cold starts. Cheaper than amending the row we just wrote.
      if (result.sent) {
        try {
          await appendSystemHealth({
            timestamp: new Date().toISOString(),
            heartbeatOk,
            whoopOk,
            lastWhoopSync,
            recentSleepEdits: recentEditsCount,
            notes: `ALERT_SENT@${new Date().toISOString()} ${failureReasons[0]}`,
          });
        } catch (e) {
          console.error("[heartbeat] failed to mark alert sent:", (e as Error).message);
        }
      }
    }
  }

  return NextResponse.json({
    ok: heartbeatOk,
    status,
    failureReasons,
    alert: { sent: alertSent, reason: alertReason },
    healthcheckPinged: Boolean(heartbeatOk && healthcheckUrl),
  });
}

function latestWhoopAgeMs(lastSync: string, now: Date): number | null {
  if (!lastSync) return null;
  // lastSync is YYYY-MM-DD. Treat the day as ending at end of Sydney day.
  const t = Date.parse(lastSync + "T23:59:59+10:00");
  if (isNaN(t)) return null;
  return now.getTime() - t;
}

function isWithin24h(iso: string, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (isNaN(t)) return false;
  return now.getTime() - t <= 24 * 3600 * 1000;
}

async function lastAlertTimestamp(): Promise<number> {
  const history = await getSystemHealthHistory(200);
  for (const h of history) {
    const m = h.notes.match(/ALERT_SENT@(\d{4}-\d{2}-\d{2}T[^\s]+)/);
    if (m) {
      const t = Date.parse(m[1]);
      if (!isNaN(t)) return t;
    }
  }
  return 0;
}
