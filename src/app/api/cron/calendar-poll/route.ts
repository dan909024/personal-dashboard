/**
 * Calendar poll. Every 5 min via GH Actions: fetches the rolling Harley
 * task window from the shared Google Calendar, diffs against the
 * snapshot in the "Calendar Events" sheet tab, sends a Telegram DM to
 * Daniel for any new event (notifiedAt empty), then writes the snapshot
 * back. firstSeenAt and notifiedAt are preserved across rewrites so a
 * re-run mid-flight never double-notifies.
 */
import { NextRequest, NextResponse } from "next/server";
import { getHarleyTaskWindow, isCalendarConfigured } from "@/lib/calendar";
import {
  readCalendarSnapshot,
  writeCalendarSnapshot,
  type CalendarSnapshotRow,
} from "@/lib/sheets";
import { sendOwnerTelegram } from "@/lib/owner-telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fmtSydney(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
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
  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: "bad cron secret" }, { status: 401 });
  }

  if (!isCalendarConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Calendar not configured (GOOGLE_CALENDAR_ID, DASHBOARD_OWNER_EMAIL)" },
      { status: 500 }
    );
  }

  const { past, future } = await getHarleyTaskWindow();
  const fetched = [...past, ...future];

  const snapshot = await readCalendarSnapshot();
  const prior = new Map<string, CalendarSnapshotRow>();
  for (const row of snapshot) prior.set(row.eventId, row);

  const now = new Date().toISOString();
  const next: CalendarSnapshotRow[] = [];
  const toNotify: { summary: string; startISO: string }[] = [];

  for (const ev of fetched) {
    const existing = prior.get(ev.eventId);
    const firstSeenAt = existing?.firstSeenAt || now;
    const notifiedAt = existing?.notifiedAt || "";

    if (!notifiedAt) {
      toNotify.push({ summary: ev.summary, startISO: ev.startISO });
    }

    next.push({
      eventId: ev.eventId,
      etag: ev.etag,
      summary: ev.summary,
      startISO: ev.startISO,
      firstSeenAt,
      // optimistically mark notified — if send fails below we retry
      // next tick by clearing this row's notifiedAt before write.
      notifiedAt: notifiedAt || now,
    });
  }

  // Send notifications. If a send fails, blank notifiedAt for that row
  // so the next tick picks it up again.
  const sendResults: { eventId: string; ok: boolean; reason?: string }[] = [];
  for (let i = 0; i < next.length; i++) {
    const row = next[i];
    const wasJustNotified = !prior.get(row.eventId)?.notifiedAt;
    if (!wasJustNotified) continue;
    const text = `Harley added: ${row.summary}\n${fmtSydney(row.startISO)}`;
    const result = await sendOwnerTelegram(text);
    if (!result.sent) {
      next[i] = { ...row, notifiedAt: "" };
      sendResults.push({ eventId: row.eventId, ok: false, reason: result.reason });
    } else {
      sendResults.push({ eventId: row.eventId, ok: true });
    }
  }

  await writeCalendarSnapshot(next);

  return NextResponse.json({
    ok: true,
    counts: {
      past: past.length,
      future: future.length,
      newNotifications: toNotify.length,
      sendFailures: sendResults.filter((r) => !r.ok).length,
    },
    sendResults,
  });
}
