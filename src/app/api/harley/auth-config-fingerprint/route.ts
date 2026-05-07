/**
 * GET /api/harley/auth-config-fingerprint
 *
 * Returns sha256 of the source-hardcoded auth identities. Harley (or
 * any external monitor) records this hash once and re-checks on a
 * cadence; drift means HARLEY_EMAIL or TRIPWIRE_TELEGRAM_CHAT_ID in
 * src/lib/harley-auth.ts changed since the last check.
 *
 * Joined with `|` so different (a, b) pairs can't collide via boundary
 * ambiguity (a string and a number, but same delimiter logic).
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { HARLEY_EMAIL, TRIPWIRE_TELEGRAM_CHAT_ID } from "@/lib/harley-auth";

export const runtime = "nodejs";

export async function GET() {
  const hash = createHash("sha256")
    .update(`${HARLEY_EMAIL}|${TRIPWIRE_TELEGRAM_CHAT_ID}`)
    .digest("hex");
  return NextResponse.json({ hash });
}
