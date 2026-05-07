/**
 * Resend email helper. Sends to Harley when the heartbeat detects a
 * failure or the Whoop webhook detects a sleep edit.
 *
 * Graceful degrade: if RESEND_API_KEY or HARLEY_EMAIL is missing, log
 * a warning and return { sent: false, reason } without throwing — so
 * heartbeat / webhook flows never fail just because alerts aren't
 * configured.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
// Resend's shared default sender. Swap for a verified domain when one
// exists; this works out-of-the-box without DNS setup.
const FROM_DEFAULT = "Personal Dashboard <dashboard@resend.dev>";

export type EmailResult =
  | { sent: true; id: string }
  | { sent: false; reason: string };

/**
 * Generic Resend send. Used for auth-related deliveries where the
 * destination address comes from a source-hardcoded constant
 * (HARLEY_EMAIL in src/lib/harley-auth.ts) rather than the env var
 * — so a leaked Vercel env var alone can't redirect login links.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.RESEND_FROM || FROM_DEFAULT;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY missing — skipping send.");
    return { sent: false, reason: "RESEND_API_KEY missing" };
  }
  if (!to) {
    console.warn("[email] sendEmail called with empty `to` — skipping.");
    return { sent: false, reason: "to missing" };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      cache: "no-store",
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`[email] Resend ${res.status}: ${body.slice(0, 300)}`);
      return { sent: false, reason: `resend_${res.status}` };
    }
    let id = "";
    try {
      id = JSON.parse(body).id || "";
    } catch {
      /* ignore */
    }
    return { sent: true, id };
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[email] send failed:", msg);
    return { sent: false, reason: msg };
  }
}

/**
 * Env-based wrapper for non-auth notifications (heartbeat alerts,
 * orgasm/edge logs, weekly summary). Reads HARLEY_EMAIL from env.
 * For auth-related sends, use sendEmail() directly with the
 * source-hardcoded constant.
 */
export async function sendHarleyEmail(
  subject: string,
  html: string,
  text: string
): Promise<EmailResult> {
  const to = process.env.HARLEY_EMAIL || "";
  if (!to) {
    console.warn("[email] HARLEY_EMAIL missing — skipping send.");
    return { sent: false, reason: "HARLEY_EMAIL missing" };
  }
  return sendEmail(to, subject, html, text);
}

/** Helper for status-style alerts. Returns { html, text } you pass in. */
export function renderAlertBody(
  status: Record<string, string | number | boolean>
): { html: string; text: string } {
  const rows = Object.entries(status)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>${escape(k)}</b></td><td>${escape(String(v))}</td></tr>`)
    .join("");
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">
      <h2 style="margin-bottom:0.5em">Personal Dashboard alert</h2>
      <table style="border-collapse:collapse">${rows}</table>
      <p style="color:#888;font-size:12px;margin-top:1em">
        Sent automatically by the dashboard heartbeat. Reply to this email if you need details.
      </p>
    </div>`;
  const text = Object.entries(status)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return { html, text };
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
