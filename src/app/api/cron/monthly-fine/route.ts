/**
 * GET /api/cron/monthly-fine
 *
 * Adds a $1000 "Monthly fee" Punishment row on the 1st of each
 * Sydney month. Idempotent on the Reason string ("Monthly fee —
 * <Month> <Year>") so duplicate firings within the same month are
 * no-ops.
 *
 * Auth: shared CRON_SECRET, same pattern as /api/cron/whoop-sync.
 *
 * Triggered by .github/workflows/monthly-fine.yml at 00:00 AEST on
 * the 1st of every month, with workflow_dispatch for manual fires.
 */
import { NextRequest, NextResponse } from "next/server";
import { appendMonthlyFineIfMissing, isConfigured } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_AMOUNT = 1000;

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
      { ok: false, error: "Sheets not configured" },
      { status: 500 }
    );
  }

  // Allow override via ?amount= for one-off adjustments.
  const amountParam = new URL(req.url).searchParams.get("amount");
  const amount = amountParam ? Number(amountParam) || DEFAULT_AMOUNT : DEFAULT_AMOUNT;

  try {
    const result = await appendMonthlyFineIfMissing(amount);
    return NextResponse.json({ ok: true, ...result, amount });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[monthly-fine] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
