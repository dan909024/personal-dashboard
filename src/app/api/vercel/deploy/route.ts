/**
 * Vercel deploy webhook.
 *
 * Vercel POSTs an event payload here when configured webhooks fire.
 * We filter for production deployments on the `main` branch and
 * email Harley a short summary (commit message, author, deploy URL).
 *
 * Signature scheme (per vercel.com/docs/observability/webhooks-overview):
 *   - Header `x-vercel-signature` is HMAC-SHA1(rawBody) keyed with
 *     the webhook secret, hex-encoded.
 *   - There's also `x-vercel-signature-256` (HMAC-SHA256, hex). We
 *     prefer 256 when present and fall back to SHA-1.
 *
 * Always returns 200 (except on bad signature → 401) so Vercel
 * doesn't retry-storm us if downstream email fails.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { sendHarleyEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_TIMEZONE = process.env.USER_TIMEZONE || "Australia/Sydney";

type DeploymentMeta = {
  githubCommitMessage?: string;
  githubCommitAuthorName?: string;
  githubCommitAuthorLogin?: string;
  githubCommitSha?: string;
  githubCommitRef?: string;
  branchAlias?: string;
};

type DeploymentPayload = {
  deployment?: {
    id?: string;
    name?: string;
    url?: string;
    inspectorUrl?: string;
    target?: string | null;
    meta?: DeploymentMeta;
  };
  team?: { id?: string; slug?: string };
  links?: { deployment?: string };
  // Some payloads put fields at the top of `payload` directly.
  url?: string;
  target?: string | null;
  meta?: DeploymentMeta;
  inspectorUrl?: string;
  name?: string;
};

type VercelEvent = {
  id?: string;
  type?: string;
  createdAt?: number;
  payload?: DeploymentPayload;
  // Some events nest the payload differently — be lenient.
  data?: DeploymentPayload;
};

const RELEVANT_TYPES = new Set([
  "deployment.created",
  "deployment.succeeded",
]);

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifySignature(req, rawBody)) {
    console.warn("[vercel-deploy] signature verification failed");
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let event: VercelEvent;
  try {
    event = JSON.parse(rawBody) as VercelEvent;
  } catch {
    return NextResponse.json({ ok: true, ignored: "bad_json" });
  }

  const type = event.type || "";
  if (!RELEVANT_TYPES.has(type)) {
    return NextResponse.json({ ok: true, ignored: type || "no_type" });
  }

  const payload = event.payload || event.data || {};
  const deployment = payload.deployment || {
    name: payload.name,
    url: payload.url,
    target: payload.target,
    meta: payload.meta,
    inspectorUrl: payload.inspectorUrl,
  };
  const meta = deployment.meta || {};

  const target = deployment.target || "";
  const ref = meta.githubCommitRef || meta.branchAlias || "";

  const isProductionMain =
    target === "production" || ref === "main" || ref === "master";
  if (!isProductionMain) {
    return NextResponse.json({
      ok: true,
      ignored: "not_production_main",
      target,
      ref,
    });
  }

  const projectName = deployment.name || "personal-dashboard";
  const url = deployment.url
    ? deployment.url.startsWith("http")
      ? deployment.url
      : `https://${deployment.url}`
    : "";
  const inspector =
    deployment.inspectorUrl ||
    payload.links?.deployment ||
    "";
  const commitSha = meta.githubCommitSha || "";
  const commitMessage = meta.githubCommitMessage || "(no commit message)";
  const author =
    meta.githubCommitAuthorName ||
    meta.githubCommitAuthorLogin ||
    "(unknown author)";

  const when = new Date(event.createdAt || Date.now());
  const sydneyTime = when.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  });
  const sydneyDate = when.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: USER_TIMEZONE,
  });

  const subject = `Dan deployed to ${projectName} at ${sydneyTime} Sydney time`;
  const shortSha = commitSha.slice(0, 7);
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">
      <h2 style="margin-bottom:0.5em">Production deploy ${escape(type === "deployment.succeeded" ? "succeeded" : "started")}</h2>
      <p><b>${escape(projectName)}</b> — ${escape(sydneyDate)} ${escape(sydneyTime)} (Sydney)</p>
      <table style="border-collapse:collapse;margin-top:0.5em">
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Commit</b></td><td style="font-family:ui-monospace,monospace">${escape(shortSha || "—")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Author</b></td><td>${escape(author)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Message</b></td><td>${escape(commitMessage)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><b>Branch</b></td><td>${escape(ref || "(unknown)")}</td></tr>
        ${url ? `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>URL</b></td><td><a href="${escapeAttr(url)}">${escape(url)}</a></td></tr>` : ""}
        ${inspector ? `<tr><td style="padding:4px 12px 4px 0;color:#666"><b>Inspect</b></td><td><a href="${escapeAttr(inspector)}">${escape(inspector)}</a></td></tr>` : ""}
      </table>
      <p style="color:#888;font-size:12px;margin-top:1em">
        Sent automatically when a production deploy event fires on Vercel.
      </p>
    </div>`;
  const text = [
    `Production deploy ${type === "deployment.succeeded" ? "succeeded" : "started"}`,
    `${projectName} — ${sydneyDate} ${sydneyTime} (Sydney)`,
    `Commit:  ${shortSha || "—"}`,
    `Author:  ${author}`,
    `Message: ${commitMessage}`,
    `Branch:  ${ref || "(unknown)"}`,
    url ? `URL:     ${url}` : "",
    inspector ? `Inspect: ${inspector}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await sendHarleyEmail(subject, html, text);
  return NextResponse.json({
    ok: true,
    type,
    target,
    ref,
    emailed: result.sent,
    reason: result.sent ? undefined : "reason" in result ? result.reason : undefined,
  });
}

function verifySignature(req: NextRequest, rawBody: string): boolean {
  const secret = process.env.VERCEL_WEBHOOK_SECRET || "";
  if (!secret) {
    console.warn(
      "[vercel-deploy] VERCEL_WEBHOOK_SECRET not set — accepting unsigned webhook."
    );
    return true;
  }
  // Prefer SHA-256 when present, fall back to SHA-1 (the original scheme).
  const sig256 =
    req.headers.get("x-vercel-signature-256") ||
    req.headers.get("X-Vercel-Signature-256") ||
    "";
  const sig1 =
    req.headers.get("x-vercel-signature") ||
    req.headers.get("X-Vercel-Signature") ||
    "";
  if (sig256) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return safeEqualHex(sig256, expected);
  }
  if (sig1) {
    const expected = crypto
      .createHmac("sha1", secret)
      .update(rawBody)
      .digest("hex");
    return safeEqualHex(sig1, expected);
  }
  return false;
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escape(s).replace(/'/g, "&#39;");
}
