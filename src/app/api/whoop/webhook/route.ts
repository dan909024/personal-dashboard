/**
 * Whoop webhook receiver.
 *
 * Fires on sleep.created and sleep.updated events. We treat:
 *   - sleep.created → log only, no alert (this is normal new sleep)
 *   - sleep.updated → fetch the full sleep record, compare against the
 *     existing Whoop Daily row for the same Sydney calendar date, and
 *     if wake/bed time or sleep duration changed, append a Sleep Edits
 *     row + email Harley with the diff.
 *
 * Signature verification: Whoop V2 webhooks sign with WHOOP_CLIENT_SECRET
 * (the same value used for the OAuth token exchange) — there is no
 * separate webhook secret. Headers are `X-WHOOP-Signature` (base64
 * HMAC-SHA256) and `X-WHOOP-Signature-Timestamp`. If
 * WHOOP_CLIENT_SECRET is missing on the server we log a warning and
 * accept the request, so a misconfigured env never silently drops
 * legitimate edit signals.
 *
 * Always returns 200 quickly. Errors are logged but don't fail the
 * response, so Whoop doesn't retry-storm us.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  appendSleepEdit,
  getLatestWhoopDaily,
} from "@/lib/sheets";
import { getSleepById } from "@/lib/whoop";
import { sendHarleyTelegram } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_TIMEZONE = process.env.USER_TIMEZONE || "Australia/Sydney";

type WhoopWebhookPayload = {
  user_id?: number;
  id?: string | number;
  type?: string;
  trace_id?: string;
  // Whoop sometimes nests data inside; we try a few common shapes.
  data?: { id?: string | number };
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifySignature(req, rawBody)) {
    console.warn("[whoop-webhook] signature verification failed; rejecting");
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let payload: WhoopWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhoopWebhookPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const eventType = payload.type || "";
  const sleepId = String(payload.id ?? payload.data?.id ?? "");

  // sleep.created: just acknowledge.
  if (eventType === "sleep.created") {
    console.log(`[whoop-webhook] sleep.created id=${sleepId} — no alert.`);
    return NextResponse.json({ ok: true, type: eventType });
  }

  if (eventType !== "sleep.updated") {
    console.log(`[whoop-webhook] ignoring event type=${eventType}`);
    return NextResponse.json({ ok: true, type: eventType, ignored: true });
  }

  if (!sleepId) {
    console.warn("[whoop-webhook] sleep.updated without id; ignoring");
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Fetch the updated sleep + the previous Whoop Daily row, compare.
  try {
    const sleep = await getSleepById(sleepId);
    if (!sleep) {
      console.warn(`[whoop-webhook] sleep ${sleepId} not found via API`);
      return NextResponse.json({ ok: true, missing: true });
    }
    const sydneyDate = localDateOf(new Date(sleep.end));
    const prior = await getLatestWhoopDaily();

    const newWake = fmtClock(new Date(sleep.end));
    const newBed = fmtClock(new Date(sleep.start));
    const newDuration =
      Math.round(
        ((new Date(sleep.end).getTime() - new Date(sleep.start).getTime()) /
          3600000) *
          10
      ) / 10;

    let priorMatchesDate = false;
    let priorWake = "";
    let priorBed = "";
    let priorSleep = "";
    if (prior && prior.date === sydneyDate) {
      priorMatchesDate = true;
      priorWake = prior.wakeTime || "";
      priorBed = prior.bedTime || "";
      priorSleep = prior.sleep || "";
    }

    const changes: { field: string; oldVal: string; newVal: string }[] = [];
    if (priorMatchesDate) {
      if (priorWake && priorWake !== newWake)
        changes.push({ field: "wakeTime", oldVal: priorWake, newVal: newWake });
      if (priorBed && priorBed !== newBed)
        changes.push({ field: "bedTime", oldVal: priorBed, newVal: newBed });
      if (priorSleep && String(priorSleep) !== String(newDuration))
        changes.push({
          field: "sleepHours",
          oldVal: String(priorSleep),
          newVal: String(newDuration),
        });
    }

    if (changes.length === 0) {
      // Either no prior row to compare against, or values match — log and bail.
      console.log(
        `[whoop-webhook] sleep.updated id=${sleepId} no detectable change (priorMatchesDate=${priorMatchesDate})`
      );
      return NextResponse.json({
        ok: true,
        type: eventType,
        changes: 0,
        note: priorMatchesDate ? "no_diff" : "no_prior_row",
      });
    }

    // Append a Sleep Edits row per detected change + send a single email.
    const detectedAt = new Date().toISOString();
    for (const c of changes) {
      try {
        await appendSleepEdit({
          detectedAt,
          sleepId,
          fieldChanged: c.field,
          oldValue: c.oldVal,
          newValue: c.newVal,
          source: "manual",
        });
      } catch (e) {
        console.error("[whoop-webhook] failed to append Sleep Edit:", (e as Error).message);
      }
    }

    const text =
      `Sleep edit detected for ${sydneyDate} (sleep ${sleepId}):\n` +
      changes.map((c) => `  - ${c.field}: ${c.oldVal} → ${c.newVal}`).join("\n") +
      `\nDetected at ${detectedAt}.`;

    sendHarleyTelegram(text).catch((e) =>
      console.error("[whoop-webhook] telegram send threw:", (e as Error).message)
    );

    return NextResponse.json({
      ok: true,
      type: eventType,
      changes: changes.length,
      sleepId,
      sydneyDate,
    });
  } catch (e) {
    console.error("[whoop-webhook] handler failed:", (e as Error).message);
    // Always 200 so Whoop doesn't retry-storm us.
    return NextResponse.json({ ok: false, error: (e as Error).message });
  }
}

/**
 * Verify the webhook signature.
 * - Whoop V2 signs webhooks with WHOOP_CLIENT_SECRET (same value used
 *   for OAuth token exchange). There is no separate webhook secret.
 * - If WHOOP_CLIENT_SECRET is missing, log a warning and accept (we
 *   never want a misconfigured env to silently drop edit signals).
 * - Otherwise compute HMAC-SHA256(timestamp + body) using the secret,
 *   base64-encode, compare in constant time.
 */
function verifySignature(req: NextRequest, rawBody: string): boolean {
  const secret = process.env.WHOOP_CLIENT_SECRET || "";
  if (!secret) {
    console.warn(
      "[whoop-webhook] WHOOP_CLIENT_SECRET not set — accepting unsigned webhook."
    );
    return true;
  }
  const signature =
    req.headers.get("x-whoop-signature") ||
    req.headers.get("X-WHOOP-Signature") ||
    "";
  const timestamp =
    req.headers.get("x-whoop-signature-timestamp") ||
    req.headers.get("X-WHOOP-Signature-Timestamp") ||
    "";
  if (!signature || !timestamp) return false;
  const computed = crypto
    .createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");
  try {
    const sigBuf = Buffer.from(signature);
    const computedBuf = Buffer.from(computed);
    if (sigBuf.length !== computedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, computedBuf);
  } catch {
    return false;
  }
}

function localDateOf(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: USER_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  });
}

