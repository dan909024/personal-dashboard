/**
 * POST /api/crypto/inbound
 *
 * Receives Crypto.com withdrawal-confirmation emails forwarded by
 * Gmail → CloudMailin (or Postmark/Resend Inbound). Each successful
 * USDT/USDC withdrawal is logged as a row in the "Harley Payments"
 * Sheet tab; that tab feeds the running balance Daniel owes Harley
 * (see getHarleyBalance in src/lib/sheets.ts).
 *
 * Auth: shared secret in CRYPTO_INGEST_SECRET. Bearer or Basic.
 *
 * Filter: only logs emails that
 *   - are from crypto.com (sender check)
 *   - have a "<USDT|USDC> withdrawal" subject
 *   - have body text containing Status: Completed AND a Total amount
 *
 * Idempotent on RFC822 Message-ID.
 *
 * The body is mostly HTML table; we strip tags to text and pull
 * fields by label-prefix regex.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appendHarleyPayment,
  harleyPaymentEmailIdExists,
  isConfigured,
  type HarleyPaymentRow,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------- Inbound payload normalization ----------
// Same pattern as /api/amex/inbound. Duplicated rather than extracted
// to a shared module — at 2 instances the duplication is bearable;
// extract if a third inbound endpoint shows up.

type RawEmail = {
  from: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  receivedAt: string;
};

type CloudMailinPayload = {
  headers?: Record<string, string | string[] | undefined>;
  envelope?: { from?: string; to?: string };
  plain?: string;
  html?: string;
};

type PostmarkPayload = {
  From?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  MessageID?: string;
  Date?: string;
};

type GenericPayload = {
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  receivedAt?: string;
};

function headerString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] || "";
  return v ?? "";
}

function adaptCloudMailin(p: CloudMailinPayload): RawEmail {
  const h = p.headers || {};
  return {
    from: headerString(h["From"] ?? h["from"]) || headerString(p.envelope?.from),
    subject: headerString(h["Subject"] ?? h["subject"]),
    text: String(p.plain ?? ""),
    html: String(p.html ?? ""),
    messageId: headerString(h["Message-ID"] ?? h["Message-Id"] ?? h["message-id"]),
    receivedAt: headerString(h["Date"] ?? h["date"]) || new Date().toISOString(),
  };
}

function adaptPostmark(p: PostmarkPayload): RawEmail {
  return {
    from: String(p.From ?? ""),
    subject: String(p.Subject ?? ""),
    text: String(p.TextBody ?? ""),
    html: String(p.HtmlBody ?? ""),
    messageId: String(p.MessageID ?? ""),
    receivedAt: String(p.Date ?? "") || new Date().toISOString(),
  };
}

function adaptGeneric(p: GenericPayload): RawEmail {
  return {
    from: String(p.from ?? ""),
    subject: String(p.subject ?? ""),
    text: String(p.text ?? ""),
    html: String(p.html ?? ""),
    messageId: String(p.messageId ?? ""),
    receivedAt: String(p.receivedAt ?? "") || new Date().toISOString(),
  };
}

function adapt(payload: unknown): RawEmail | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.headers === "object" && (typeof p.plain === "string" || typeof p.html === "string")) {
    return adaptCloudMailin(p as CloudMailinPayload);
  }
  if (typeof p.From === "string" && (typeof p.TextBody === "string" || typeof p.HtmlBody === "string")) {
    return adaptPostmark(p as PostmarkPayload);
  }
  if (typeof p.from === "string" || typeof p.subject === "string") {
    return adaptGeneric(p as GenericPayload);
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pickBody(email: RawEmail): string {
  if (email.text && email.text.trim().length > 0) return email.text;
  if (email.html) return htmlToText(email.html);
  return "";
}

// ---------- Crypto.com parser ----------

function isFromCryptoCom(from: string): boolean {
  return /crypto\.com/i.test(from);
}

const SUBJECT_RE = /^\s*(USDT|USDC)\s+withdrawal\s+(?:request\s+confirmed|is\s+successful|confirmed)/i;

type CryptoParsed = {
  ok: boolean;
  reason?: string;
  amount?: number;
  currency?: "USDT" | "USDC";
  network?: string;
  toAddress?: string;
  status?: string;
};

function parseCryptoEmail(email: RawEmail): CryptoParsed {
  const subjMatch = email.subject.match(SUBJECT_RE);
  if (!subjMatch) return { ok: false, reason: "subject_not_withdrawal" };
  const currency = subjMatch[1].toUpperCase() as "USDT" | "USDC";

  const body = pickBody(email);
  if (!body) return { ok: false, reason: "empty_body" };

  // Status: Completed
  const statusMatch = body.match(/Status[:\s]+([A-Za-z]+)/i);
  const status = statusMatch ? statusMatch[1] : "";
  if (status.toLowerCase() !== "completed") {
    return { ok: false, reason: `status_${status.toLowerCase() || "missing"}`, status };
  }

  // Total: 990.0 USDT (the amount that left the wallet)
  const totalMatch = body.match(
    new RegExp(`Total[:\\s]+([\\d,]+\\.?\\d*)\\s*${currency}`, "i")
  );
  if (!totalMatch) return { ok: false, reason: "total_not_found", currency, status };
  const amount = Number(totalMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount_invalid", currency, status };
  }

  const networkMatch = body.match(/Network\s*Type[:\s]+([A-Za-z][A-Za-z0-9 ]{0,30}?)(?=\s+(?:To|Fee|$))/i);
  const network = networkMatch ? networkMatch[1].trim() : "";

  // The destination address is whatever long alphanumeric string follows "To".
  // Filter out short tokens like "USDT" / "USDC" / "Wallet".
  const toMatch = body.match(/(?:^|\s)To[:\s]+([A-Za-z0-9]{20,})/);
  const toAddress = toMatch ? toMatch[1] : "";

  return { ok: true, amount, currency, network, toAddress, status };
}

function parseDate(fallbackIso: string): string {
  const d = new Date(fallbackIso);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// ---------- Route ----------

function bad(reason: string, status = 400) {
  return NextResponse.json({ ok: false, error: reason }, { status });
}

function extractAuthSecret(authHeader: string): string {
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  if (authHeader.startsWith("Basic ")) {
    const b64 = authHeader.slice("Basic ".length).trim();
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      return colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
    } catch {
      return "";
    }
  }
  return "";
}

export async function POST(req: NextRequest) {
  const expected = process.env.CRYPTO_INGEST_SECRET || "";
  if (!expected) return bad("CRYPTO_INGEST_SECRET not configured", 500);

  const auth = req.headers.get("authorization") || "";
  const provided = extractAuthSecret(auth);
  if (provided !== expected) return bad("bad_secret", 401);

  if (!isConfigured()) return bad("sheets_not_configured", 500);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return bad("bad_json");
  }

  const email = adapt(payload);
  if (!email) return bad("unrecognised_payload_shape");

  // Gmail forwarding-verification special-case (same as /api/amex/inbound).
  // CloudMailin Free only PRESERVES response bodies for 4xx — so we
  // intentionally return 422 with the verification code/URL extracted
  // from the body. Must run BEFORE the missing_message_id check, since
  // Gmail's verification email lacks a stable Message-ID.
  if (/forwarding-noreply@google\.com/i.test(email.from)) {
    const body = pickBody(email);
    const codes = Array.from(new Set(
      Array.from(body.matchAll(/\b(\d{6,12})\b/g)).map((m) => m[1])
    ));
    const urls = Array.from(new Set(
      Array.from(body.matchAll(/https?:\/\/[^\s"'<>]+/g)).map((m) => m[0])
    ));
    return NextResponse.json({
      gmail_forwarding_verification: true,
      code_candidates: codes,
      url_candidates: urls,
      body_preview: body.slice(0, 1500),
      hint: "422 is intentional — CloudMailin Free only preserves response bodies for 4xx. Look for a confirmation URL in url_candidates or a code in code_candidates.",
    }, { status: 422 });
  }

  if (!email.messageId) return bad("missing_message_id");
  if (!isFromCryptoCom(email.from)) {
    return bad("sender_not_crypto_com", 422);
  }

  if (await harleyPaymentEmailIdExists(email.messageId)) {
    return NextResponse.json({ ok: true, deduped: true, messageId: email.messageId });
  }

  const parsed = parseCryptoEmail(email);
  if (!parsed.ok) {
    // Don't 4xx the inbound provider — Crypto.com sends many email
    // types (deposit confirmations, security alerts, etc.) and we
    // only care about USDT/USDC withdrawals. Anything else is a 200
    // with a `skipped` flag so the provider doesn't retry.
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: parsed.reason,
      subject: email.subject,
    });
  }

  const row: HarleyPaymentRow = {
    date: parseDate(email.receivedAt),
    amount: parsed.amount!,
    currency: parsed.currency!,
    network: parsed.network ?? "",
    toAddress: parsed.toAddress ?? "",
    emailId: email.messageId,
    subject: email.subject,
    syncedAt: new Date().toISOString(),
  };

  try {
    await appendHarleyPayment(row);
    return NextResponse.json({ ok: true, action: "appended", row });
  } catch (e) {
    console.error("[crypto/inbound] append failed:", (e as Error).message);
    return bad("sheet_append_failed", 500);
  }
}
