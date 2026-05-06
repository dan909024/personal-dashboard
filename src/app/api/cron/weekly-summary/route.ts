/**
 * Weekly summary email — sent to Harley Sunday evening (Sydney) so she
 * has evidence-of-life from the dashboard each week. The point is the
 * absence of this email is itself a signal: if HARLEY_EMAIL is silently
 * swapped or the workflow stops running, Harley notices within ~7 days.
 *
 * Triggered by GitHub Actions (`.github/workflows/weekly-summary.yml`),
 * not Vercel — Hobby plan caps at 2 cron jobs and we already use both
 * (whoop-sync, heartbeat). Auth still uses CRON_SECRET via the
 * Authorization Bearer header for symmetry with the other cron routes.
 *
 * Includes:
 *   - Whoop dailies (recovery / strain / sleep) for the last 7 days
 *   - Amex transactions for the last 7 days
 *   - Sleep edits in the last 7 days
 *   - Punishments owed this week
 *   - Heartbeat status snapshot
 *
 * IMPORTANT: returns non-2xx if the email send fails. The GitHub Actions
 * workflow uses HTTP status to decide whether to ping Healthchecks.io —
 * a silent email failure must NOT result in a green ping, otherwise the
 * tripwire goes blind.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  isConfigured,
  getRecentWhoopDaily,
  getRecentSleepEdits,
  getRecentAmexTransactions,
  getLatestSystemHealth,
  getPunishments,
  type WhoopDaily,
  type SleepEdit,
  type SystemHealth,
  type Punishment,
  type AmexTransactionRow,
} from "@/lib/sheets";
import { sendHarleyEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  if (!isConfigured()) {
    return NextResponse.json(
      { ok: false, error: "sheets_not_configured" },
      { status: 500 }
    );
  }

  const [whoop, sleepEdits, amex, health, punishments] = await Promise.all([
    getRecentWhoopDaily(7).catch(() => []),
    getRecentSleepEdits(50).catch(() => []),
    getRecentAmexTransactions(7).catch(() => []),
    getLatestSystemHealth().catch(() => null),
    getPunishments().catch(() => []),
  ]);

  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
  const recentEdits = sleepEdits.filter((e) => {
    const t = Date.parse(e.detectedAt);
    return !isNaN(t) && t >= sevenDaysAgo;
  });

  const weekEnding = todayInSydney();
  const { html, text, subject } = renderWeeklySummary({
    weekEnding,
    whoop,
    amex,
    sleepEdits: recentEdits,
    health,
    punishments,
  });

  const sendResult = await sendHarleyEmail(subject, html, text);

  // Non-2xx if email failed, so the GitHub Action correctly fails and
  // skips the Healthchecks.io ping. Body still includes the snapshot
  // for debugging from the workflow log.
  if (!sendResult.sent) {
    return NextResponse.json(
      {
        ok: false,
        weekEnding,
        email: sendResult,
        counts: counts(whoop, amex, recentEdits, punishments),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    weekEnding,
    email: sendResult,
    counts: counts(whoop, amex, recentEdits, punishments),
  });
}

function counts(
  whoop: WhoopDaily[],
  amex: AmexTransactionRow[],
  edits: SleepEdit[],
  punishments: Punishment[]
) {
  return {
    whoopDays: whoop.length,
    amexTransactions: amex.length,
    sleepEdits: edits.length,
    punishments: punishments.length,
  };
}

// ---------- Renderer ----------

type SummaryInput = {
  weekEnding: string;
  whoop: WhoopDaily[];
  amex: AmexTransactionRow[];
  sleepEdits: SleepEdit[];
  health: SystemHealth | null;
  punishments: Punishment[];
};

function renderWeeklySummary(input: SummaryInput): {
  html: string;
  text: string;
  subject: string;
} {
  const { weekEnding, whoop, amex, sleepEdits, health, punishments } = input;
  const owed = punishments.reduce((s, p) => s + (p.paid ? 0 : p.amount), 0);
  const amexCharges = amex.filter((a) => a.type === "charge");
  const amexTotal = amexCharges.reduce((s, a) => s + a.amount, 0);

  const subject = `Weekly summary — ${weekEnding}`;

  // ---------- HTML ----------
  const whoopRows = whoop.length
    ? whoop
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map(
          (w) =>
            `<tr>
               <td style="padding:4px 12px 4px 0;color:#666">${escape(w.date)}</td>
               <td>${escape(w.recovery || "—")}</td>
               <td>${escape(w.strain || "—")}</td>
               <td>${escape(fmtSleep(w.sleep))}</td>
               <td>${escape(w.wakeTime || "—")}</td>
             </tr>`
        )
        .join("")
    : `<tr><td colspan="5" style="color:#888">No Whoop rows in the last 7 days.</td></tr>`;

  const amexRows = amexCharges.length
    ? amexCharges
        .slice(0, 25)
        .map(
          (a) =>
            `<tr>
               <td style="padding:4px 12px 4px 0;color:#666">${escape(a.date)}</td>
               <td>${escape(a.merchant || "—")}</td>
               <td><b>$${a.amount.toFixed(2)}</b> ${escape(a.currency || "")}</td>
               <td style="color:#888;font-size:11px">${escape(a.cardLast4 ? "••" + a.cardLast4 : "")}</td>
             </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="color:#888">No Amex charges this week.</td></tr>`;

  const editsRows = sleepEdits.length
    ? sleepEdits
        .slice(0, 10)
        .map(
          (e) =>
            `<tr>
               <td style="padding:4px 12px 4px 0;color:#666">${escape(fmtIsoShort(e.detectedAt))}</td>
               <td><b>${escape(e.fieldChanged)}</b>: <span style="color:#a00">${escape(e.oldValue || "—")}</span> → <span style="color:#070">${escape(e.newValue || "—")}</span></td>
             </tr>`
        )
        .join("")
    : `<tr><td colspan="2" style="color:#070">No sleep edits this week ✓</td></tr>`;

  const healthBlock = health
    ? `<p style="margin:0">Heartbeat: <b style="color:${health.heartbeatOk ? "#070" : "#a00"}">${health.heartbeatOk ? "OK" : "broken"}</b> &middot; Whoop: <b style="color:${health.whoopOk ? "#070" : "#a00"}">${health.whoopOk ? "OK" : "stale"}</b> &middot; last tick ${escape(fmtIsoShort(health.timestamp))}</p>${health.notes ? `<p style="color:#666;margin:4px 0 0 0;font-size:12px">${escape(health.notes)}</p>` : ""}`
    : `<p style="color:#888;margin:0">No System Health row yet.</p>`;

  const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5;max-width:680px;margin:0 auto;padding:16px">
  <h2 style="margin:0 0 4px 0">Weekly summary — ${escape(weekEnding)}</h2>
  <p style="color:#666;margin:0 0 24px 0;font-size:12px">
    Auto-generated. If this email stops arriving on Sundays, something has changed about how Daniel's dashboard delivers alerts to you.
  </p>

  <h3 style="margin:24px 0 8px 0">Whoop (last 7 days)</h3>
  <table style="border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;color:#888"><th>Date</th><th>Recovery</th><th>Strain</th><th>Sleep</th><th>Wake</th></tr></thead>
    <tbody>${whoopRows}</tbody>
  </table>

  <h3 style="margin:24px 0 8px 0">Amex charges (last 7 days)</h3>
  <p style="color:#666;margin:0 0 8px 0;font-size:12px">Total: <b>$${amexTotal.toFixed(2)}</b> across ${amexCharges.length} charge${amexCharges.length === 1 ? "" : "s"}</p>
  <table style="border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;color:#888"><th>Date</th><th>Merchant</th><th>Amount</th><th>Card</th></tr></thead>
    <tbody>${amexRows}</tbody>
  </table>

  <h3 style="margin:24px 0 8px 0">Sleep edits (last 7 days)</h3>
  <table style="border-collapse:collapse;font-size:13px">
    <tbody>${editsRows}</tbody>
  </table>

  <h3 style="margin:24px 0 8px 0">Money</h3>
  <p style="margin:0">Outstanding this week: <b style="color:${owed > 0 ? "#a00" : "#070"}">$${owed}</b></p>

  <h3 style="margin:24px 0 8px 0">System health</h3>
  ${healthBlock}

  <p style="color:#888;font-size:11px;margin-top:32px">
    Generated by the weekly GitHub Actions workflow. Reply to this email if anything looks off — it's the cleanest signal something's been tampered with.
  </p>
</body></html>`;

  // ---------- Plain text ----------
  const textLines: string[] = [];
  textLines.push(`Weekly summary — ${weekEnding}`);
  textLines.push("");
  textLines.push("Whoop (last 7 days):");
  if (whoop.length === 0) textLines.push("  (no rows)");
  else
    for (const w of whoop.slice().sort((a, b) => (a.date < b.date ? 1 : -1))) {
      textLines.push(
        `  ${w.date}  recovery=${w.recovery || "-"}  strain=${w.strain || "-"}  sleep=${fmtSleep(w.sleep)}  wake=${w.wakeTime || "-"}`
      );
    }
  textLines.push("");
  textLines.push(
    `Amex charges (total $${amexTotal.toFixed(2)} across ${amexCharges.length}):`
  );
  if (amexCharges.length === 0) textLines.push("  (none)");
  else
    for (const a of amexCharges.slice(0, 25)) {
      textLines.push(
        `  ${a.date}  ${a.merchant.padEnd(28).slice(0, 28)}  $${a.amount.toFixed(2)} ${a.currency}  ${a.cardLast4 ? "••" + a.cardLast4 : ""}`
      );
    }
  textLines.push("");
  textLines.push(`Sleep edits (last 7 days): ${sleepEdits.length}`);
  for (const e of sleepEdits.slice(0, 10)) {
    textLines.push(
      `  ${fmtIsoShort(e.detectedAt)}  ${e.fieldChanged}: ${e.oldValue || "-"} -> ${e.newValue || "-"}`
    );
  }
  textLines.push("");
  textLines.push(`Outstanding this week: $${owed}`);
  textLines.push(
    `Heartbeat: ${health ? (health.heartbeatOk ? "OK" : "broken") : "no row yet"}`
  );

  return { html, text: textLines.join("\n"), subject };
}

// ---------- Helpers ----------

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtSleep(sleep: string): string {
  if (!sleep) return "—";
  const n = Number(sleep);
  if (!Number.isFinite(n)) return sleep;
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtIsoShort(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return iso;
  return new Date(t).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function todayInSydney(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}
