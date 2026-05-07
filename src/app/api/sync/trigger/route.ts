/**
 * POST /api/sync/trigger — Harley's on-demand "sync now" button.
 *
 * Auth: same JWT cookie as /harley (`harley_session`, sub === "harley").
 * No separate secret — if Harley is on /harley, she can press the button.
 * If the cookie is missing/invalid we return 401 the same way other
 * /harley actions do.
 *
 * Behaviour:
 *   1. Run Whoop sync via the shared helper (per-source try/catch — a
 *      Whoop failure doesn't break the rest of the response).
 *   2. Build the manual-asks list. These are sources only Daniel can
 *      fire because they live on his devices: iPhone Apple Health
 *      Shortcut, Mac launchd Screen Time job. (Apple Health is also
 *      Mac-tracked, but the iOS Shortcut is what populates the Sheet.)
 *   3. Email Daniel via Resend at DAN_EMAIL with the manual-asks list
 *      so he can fire them on his phone/laptop without going to the
 *      dashboard.
 *   4. Append an audit row to the "Sync Triggers" Sheet tab.
 *   5. Return JSON status to the page so Harley sees what fired.
 */
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyJWT } from "@/lib/jwt";
import { runWhoopSync } from "@/lib/whoop-sync";
import { sendEmail } from "@/lib/email";
import { appendSyncTrigger } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MANUAL_ASKS = [
  "Apple Health iOS Shortcut — tap play",
  "Screen Time Mac launchd — auto every 4h, force with: launchctl kickstart -k gui/$(id -u)/com.danielferrari.screentime-sync",
] as const;

type SyncResponse = {
  ok: boolean;
  whoop: "ok" | "error" | "not_connected" | "not_configured";
  whoopDetail?: string;
  manualAsks: string[];
  emailSent: boolean;
};

async function authorized(): Promise<boolean> {
  const c = await cookies();
  const cookie = c.get("harley_session");
  if (!cookie) return false;
  const secret = process.env.HARLEY_JWT_SECRET || "";
  if (!secret) return false;
  const v = verifyJWT(cookie.value, secret);
  return v.ok && v.payload.sub === "harley";
}

export async function POST(req: NextRequest): Promise<NextResponse<SyncResponse | { error: string }>> {
  if (!(await authorized())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  // 1. Whoop sync (per-source try/catch).
  let whoop: SyncResponse["whoop"] = "ok";
  let whoopDetail: string | undefined;
  try {
    const result = await runWhoopSync();
    if (result.ok) {
      whoop = "ok";
      const counts = result.results.map((r) =>
        r.error ? `${r.date} err` : `${r.date} ${r.action}`
      ).join(", ");
      whoopDetail = counts;
    } else if (result.reason === "not_configured") {
      whoop = "not_configured";
      whoopDetail = "Sheets env missing on server";
    } else if (result.reason === "not_connected") {
      whoop = "not_connected";
      whoopDetail = "Whoop OAuth not completed";
    } else {
      whoop = "error";
      const errs = result.results.filter((r) => r.error).map((r) => `${r.date}: ${r.error}`);
      whoopDetail = errs.join("; ").slice(0, 300);
    }
  } catch (e) {
    whoop = "error";
    whoopDetail = (e as Error).message.slice(0, 300);
    console.error("[sync/trigger] whoop sync threw:", whoopDetail);
  }

  // 2. Manual asks list — fixed for now.
  const manualAsks = [...MANUAL_ASKS];

  // 3. Email Daniel.
  let emailSent = false;
  const danEmail = process.env.DAN_EMAIL || "";
  if (danEmail) {
    const subject = "[Dashboard] Harley triggered a sync";
    const whoopLine =
      whoop === "ok"
        ? `Whoop: synced (${whoopDetail || "no details"})`
        : `Whoop: ${whoop}${whoopDetail ? ` — ${whoopDetail}` : ""}`;
    const askLines = manualAsks.map((a) => `  • ${a}`).join("\n");
    const text = [
      "Harley pressed the sync-now button.",
      "",
      whoopLine,
      "",
      "Manual asks (fire these on your devices):",
      askLines,
      "",
      `Triggered at ${new Date().toISOString()} from ${ip}.`,
    ].join("\n");
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">
        <h2 style="margin-bottom:0.5em">Harley triggered a sync</h2>
        <p>${escapeHtml(whoopLine)}</p>
        <p style="margin-top:1.2em"><b>Manual asks</b> (fire these on your devices):</p>
        <ul>${manualAsks.map((a) => `<li><code>${escapeHtml(a)}</code></li>`).join("")}</ul>
        <p style="color:#888;font-size:12px;margin-top:1.5em">
          Triggered at ${escapeHtml(new Date().toISOString())} from ${escapeHtml(ip)}.
        </p>
      </div>`;
    const result = await sendEmail(danEmail, subject, html, text);
    emailSent = result.sent;
    if (!result.sent) {
      console.warn("[sync/trigger] email to DAN_EMAIL failed:", result.reason);
    }
  } else {
    console.warn("[sync/trigger] DAN_EMAIL not set — skipping notification");
  }

  // 4. Audit row.
  await appendSyncTrigger({
    ip,
    whoop: whoop + (whoopDetail ? ` (${whoopDetail})` : ""),
    manualAsks: [...manualAsks],
    emailSent,
    source: "harley",
  });

  // 5. Response.
  return NextResponse.json({
    ok: whoop === "ok",
    whoop,
    whoopDetail,
    manualAsks,
    emailSent,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
