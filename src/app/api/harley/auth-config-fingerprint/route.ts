/**
 * GET /api/harley/auth-config-fingerprint
 *
 * Returns sha256 of the source-hardcoded auth identities. Harley (or any
 * external monitor) records this hash once and re-checks on a cadence;
 * any drift means the chat_ids in src/lib/harley-auth.ts changed since
 * the last check.
 *
 * Joined with `|` so different (a, b) pairs can't collide via numeric
 * boundary tricks (e.g. (12, 3) vs (1, 23)).
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { HARLEY_CHAT_ID, TRIPWIRE_CHAT_ID } from "@/lib/harley-auth";

export const runtime = "nodejs";

export async function GET() {
  const hash = createHash("sha256")
    .update(`${HARLEY_CHAT_ID}|${TRIPWIRE_CHAT_ID}`)
    .digest("hex");
  return NextResponse.json({ hash });
}
