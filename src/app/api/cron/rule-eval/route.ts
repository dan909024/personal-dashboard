/**
 * GET /api/cron/rule-eval
 *
 * Walks the Harley Meter rules and appends Punishments rows for any
 * failed periods that haven't already been fined. Idempotent on
 * (ruleId, periodStart) — see src/lib/rule-eval.ts for the rule set
 * and per-rule fine amounts.
 *
 * Auth: shared CRON_SECRET, same pattern as monthly-fine.
 *
 * Triggered by .github/workflows/rule-eval.yml at 02:00 Sydney via
 * GitHub Actions. Supports `?dry_run=1` for a no-write preview.
 */
import { NextRequest, NextResponse } from "next/server";
import { evaluateRulesAndFine } from "@/lib/rule-eval";
import { isConfigured } from "@/lib/sheets";

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
  const url = new URL(req.url);
  const queryParam = url.searchParams.get("secret") || "";
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

  const dryRun = url.searchParams.get("dry_run") === "1";
  const today = url.searchParams.get("today") || undefined;

  try {
    const result = await evaluateRulesAndFine({ dryRun, today });
    return NextResponse.json({
      ok: true,
      dryRun,
      counts: {
        appended: result.appended.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
      },
      ...result,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[rule-eval] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
