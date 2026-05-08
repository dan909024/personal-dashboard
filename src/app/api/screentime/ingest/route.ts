/**
 * POST /api/screentime/ingest
 *
 * Receives daily screen-time aggregates from:
 *   - iOS Shortcut Personal Automation (source: "ios_shortcut")
 *   - Mac launchd knowledgeC.db poller (source: "mac_launchd")
 *   - Mac UI scrape of iPhone activity (source: "mac_ui_iphone")
 *
 * Auth: shared secret in SCREENTIME_INGEST_SECRET, sent as
 *   Authorization: Bearer <secret>
 *
 * Storage: append-only into the "Screen Time" tab. Re-posts append
 * additional rows; readers dedupe to the latest (date, source, label)
 * tuple by syncedAt. This keeps writes cheap (no scan-and-delete) and
 * preserves an audit trail.
 *
 * Payload shape:
 *   {
 *     "date": "YYYY-MM-DD",          // calendar day in user TZ
 *     "tz": "Australia/Sydney",      // optional, currently informational
 *     "source": "ios_shortcut",      // required
 *     "items": [
 *       { "label": "Telegram", "category": "Social", "minutes": 42 },
 *       { "label": "Safari",   "category": "Productivity", "minutes": 18 }
 *     ]
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appendScreentimeRows,
  isConfigured,
  type ScreenTimeRow,
} from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IngestItem = {
  label?: unknown;
  category?: unknown;
  minutes?: unknown;
};

type IngestPayload = {
  date?: unknown;
  tz?: unknown;
  source?: unknown;
  items?: unknown;
};

const ALLOWED_SOURCES = new Set(["ios_shortcut", "mac_launchd", "mac_ui_iphone"]);
const MAX_ITEMS = 200;
const MAX_LABEL_LEN = 200;
const MAX_MINUTES = 24 * 60;

function bad(reason: string, status = 400) {
  return NextResponse.json({ ok: false, error: reason }, { status });
}

export async function POST(req: NextRequest) {
  const expected = process.env.SCREENTIME_INGEST_SECRET || "";
  if (!expected) {
    return bad("SCREENTIME_INGEST_SECRET not configured", 500);
  }
  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  if (provided !== expected) return bad("bad_secret", 401);

  if (!isConfigured()) return bad("sheets_not_configured", 500);

  let payload: IngestPayload;
  try {
    payload = (await req.json()) as IngestPayload;
  } catch {
    return bad("bad_json");
  }

  const date = String(payload.date ?? "");
  const source = String(payload.source ?? "");
  const items = Array.isArray(payload.items) ? (payload.items as IngestItem[]) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("bad_date");
  if (!ALLOWED_SOURCES.has(source)) return bad("bad_source");
  if (!items) return bad("missing_items");
  if (items.length > MAX_ITEMS) return bad("too_many_items");

  const syncedAt = new Date().toISOString();
  const rows: ScreenTimeRow[] = [];
  for (const it of items) {
    const label = String(it.label ?? "").trim().slice(0, MAX_LABEL_LEN);
    if (!label) continue;
    const minutesRaw = Number(it.minutes);
    if (!Number.isFinite(minutesRaw)) continue;
    const minutes = Math.max(0, Math.min(MAX_MINUTES, Math.round(minutesRaw)));
    if (minutes === 0) continue;
    const category = String(it.category ?? "").trim().slice(0, 64);
    rows.push({ date, source, label, category, minutes, syncedAt });
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, rows: 0, note: "no_valid_items" });
  }

  try {
    await appendScreentimeRows(rows);
    return NextResponse.json({
      ok: true,
      rows: rows.length,
      date,
      source,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[screentime-ingest] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
