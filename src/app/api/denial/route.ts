/**
 * GET /api/denial
 *
 * Returns the current Denial Tracker target date from the Sheet.
 * The value is set server-side only (no admin UI yet) — edit the
 * "Denial" tab's `denial_end_date` row directly.
 */
import { NextResponse } from "next/server";
import { getDenialEndDate, isConfigured } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json({ endDate: null });
  }
  const endDate = await getDenialEndDate();
  return NextResponse.json({ endDate });
}
