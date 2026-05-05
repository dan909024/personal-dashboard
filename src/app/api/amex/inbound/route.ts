/**
 * POST /api/amex/inbound
 *
 * Receives parsed Amex AU transaction-alert emails from an inbound-email
 * provider (CloudMailin / Postmark / Resend Inbound). The flow is:
 *
 *   Amex (alerts@welcome.americanexpress.com) → regbeniacdlaw@gmail.com
 *     → Gmail filter auto-forwards to <something>@cloudmailin.net
 *       → CloudMailin POSTs JSON here
 *         → we parse + append a row to "Amex Transactions" sheet
 *
 * Auth: shared secret in AMEX_INGEST_SECRET. Two accepted formats:
 *   - Authorization: Bearer <secret>   — Postmark, Resend, anything that
 *     supports custom headers.
 *   - Authorization: Basic base64(<any>:<secret>)  — CloudMailin Free,
 *     which does basic auth via target URL credentials. Configure target
 *     as https://amex:<secret>@.../api/amex/inbound; the username is
 *     ignored, only the password must equal AMEX_INGEST_SECRET.
 *
 * Idempotency: we dedupe by RFC822 Message-ID (column G in the sheet).
 * Inbound providers retry on non-2xx, so duplicate deliveries WILL happen.
 *
 * Parser: Amex AU alert formats vary by alert type. v1 supports:
 *   - "Charge Notification" / "Spending Alert" → type=charge
 *   - Weekly balance summary                    → type=balance
 *   - Unknown                                   → type=unparsed (still stored
 *     so we don't lose data while iterating on regexes)
 *
 * The parser regexes are built from documented Amex AU alert text; some
 * pattern variants likely exist that v1 won't catch. When that happens
 * the row lands as "unparsed" with the full subject preserved — sample
 * one and tighten the parser.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  amexEmailIdExists,
  appendAmexTransaction,
  isConfigured,
  type AmexTransactionRow,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------- Inbound payload normalization ----------

/**
 * Normalised view of an inbound email regardless of provider. Each
 * supported provider has a small adapter below that maps its payload
 * shape into this.
 */
type RawEmail = {
  from: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  receivedAt: string; // ISO
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
  if (Array.isArray(v)) return v.join(", ");
  return String(v ?? "");
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

/** Detect provider by payload shape. */
function adapt(payload: unknown): RawEmail | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  // CloudMailin: has `headers` + (`plain` or `html`)
  if (typeof p.headers === "object" && (typeof p.plain === "string" || typeof p.html === "string")) {
    return adaptCloudMailin(p as CloudMailinPayload);
  }
  // Postmark: has `From` + `Subject` + (`TextBody` or `HtmlBody`)
  if (typeof p.From === "string" && (typeof p.TextBody === "string" || typeof p.HtmlBody === "string")) {
    return adaptPostmark(p as PostmarkPayload);
  }
  // Generic: lowercase keys
  if (typeof p.from === "string" || typeof p.subject === "string") {
    return adaptGeneric(p as GenericPayload);
  }
  return null;
}

// ---------- Amex parser ----------

const AMEX_SENDER_PATTERNS = [
  /americanexpress\.com/i,
  /aexp\.com/i,
];

function isFromAmex(from: string): boolean {
  return AMEX_SENDER_PATTERNS.some((re) => re.test(from));
}

/** Strip HTML tags to plain text as a fallback when `text` is empty. */
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

/**
 * Detect alert type from subject + body. Subjects vary; we match a few
 * known variants and fall back to body keywords.
 */
function detectType(email: RawEmail, body: string): AmexTransactionRow["type"] {
  const subj = email.subject.toLowerCase();
  const txt = body.toLowerCase();

  // Balance summary keywords
  if (
    /balance/.test(subj) &&
    (/weekly/.test(subj) || /summary/.test(subj) || /update/.test(subj))
  ) {
    return "balance";
  }
  if (/your weekly amex/.test(subj) || /balance update/.test(subj)) {
    return "balance";
  }

  // Charge keywords (covers "Charge Notification", "Spending Alert",
  // "Large Purchase Approved", etc.)
  if (
    /charge|purchase|spend|transaction|approved/.test(subj) ||
    /charge of \$|purchase of \$|transaction of \$|spent \$/.test(txt)
  ) {
    return "charge";
  }
  return "unparsed";
}

/** Parse the first AUD/USD-style amount in the body. Returns 0 if none. */
function parseAmount(body: string): { amount: number; currency: string } {
  // Match patterns like "$1,234.56", "AUD 12.34", "A$50.00"
  const patterns: Array<[RegExp, string]> = [
    [/A\$\s?([\d,]+\.\d{2})/i, "AUD"],
    [/AUD\s?([\d,]+\.\d{2})/i, "AUD"],
    [/USD\s?([\d,]+\.\d{2})/i, "USD"],
    [/\$([\d,]+\.\d{2})/, "AUD"], // default: AUD if just $
  ];
  for (const [re, currency] of patterns) {
    const m = body.match(re);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return { amount: n, currency };
    }
  }
  return { amount: 0, currency: "AUD" };
}

/** Pull merchant name. Amex alerts typically use "at MERCHANT" or "to MERCHANT". */
function parseMerchant(body: string): string {
  const patterns = [
    /(?:charge|purchase|transaction)\s+(?:of\s+\$[\d,.]+)?\s+at\s+([^\n.,]{2,80})/i,
    /\bat\s+([A-Z][A-Za-z0-9 &'.\-]{2,80}?)(?:\s+on\s+|\s+for\s+|\s+was\s+|[.,\n])/,
    /merchant[:\s]+([^\n.,]{2,80})/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1]) return m[1].trim().replace(/\s+/g, " ");
  }
  return "";
}

function parseCardLast4(body: string): string {
  const patterns = [
    /ending in\s+(\d{4,5})/i,
    /\bx{2,}(\d{4})\b/i,
    /\*+(\d{4})\b/,
    /card\s+ending\s+(\d{4})/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return m[1].slice(-4);
  }
  return "";
}

function parseDate(body: string, fallbackIso: string): string {
  // "on 5 May 2026" or "on 05/05/2026"
  const m1 = body.match(/on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m1) {
    const d = new Date(`${m1[1]} ${m1[2]} ${m1[3]} 12:00:00 UTC`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const m2 = body.match(/on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) {
    const [, dd, mm, yyyy] = m2; // AU: dd/mm/yyyy
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Fall back to email received date
  const d = new Date(fallbackIso);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function parseAmexEmail(email: RawEmail): AmexTransactionRow {
  const body = pickBody(email);
  const type = detectType(email, body);
  const { amount, currency } = parseAmount(body);
  const merchant = type === "balance" ? "(balance update)" : parseMerchant(body);
  const cardLast4 = parseCardLast4(body);
  const date = parseDate(body, email.receivedAt);
  return {
    date,
    type,
    merchant,
    amount,
    currency,
    cardLast4,
    emailId: email.messageId,
    subject: email.subject,
    syncedAt: new Date().toISOString(),
  };
}

// ---------- Route ----------

function bad(reason: string, status = 400) {
  return NextResponse.json({ ok: false, error: reason }, { status });
}

/**
 * Extract the secret from an Authorization header. Supports:
 *   - "Bearer <secret>"        → returns <secret>
 *   - "Basic base64(<u>:<p>)"  → returns <p> (password); username ignored
 * Returns "" if the header is missing or unparseable.
 */
function extractAuthSecret(authHeader: string): string {
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  if (authHeader.startsWith("Basic ")) {
    const b64 = authHeader.slice("Basic ".length).trim();
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const colonIdx = decoded.indexOf(":");
      // Username before first colon is ignored; everything after is the
      // secret. This way users can put any username in the URL credentials.
      return colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
    } catch {
      return "";
    }
  }
  return "";
}

export async function POST(req: NextRequest) {
  const expected = process.env.AMEX_INGEST_SECRET || "";
  if (!expected) return bad("AMEX_INGEST_SECRET not configured", 500);

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
  if (!email.messageId) return bad("missing_message_id");
  if (!isFromAmex(email.from)) {
    // Reject anything not from Amex — defense against accidental
    // forwarding rules or malicious POSTs that pass auth.
    return bad("sender_not_amex", 422);
  }

  // Idempotency: if we've seen this Message-ID before, no-op.
  if (await amexEmailIdExists(email.messageId)) {
    return NextResponse.json({ ok: true, deduped: true, messageId: email.messageId });
  }

  const row = parseAmexEmail(email);
  try {
    await appendAmexTransaction(row);
    return NextResponse.json({
      ok: true,
      type: row.type,
      merchant: row.merchant,
      amount: row.amount,
      currency: row.currency,
      cardLast4: row.cardLast4,
      date: row.date,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[amex-inbound] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
