import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildAuthorizeUrl, whoopOAuthConfigured } from "@/lib/whoop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "whoop_oauth_state";
const STATE_TTL_SECONDS = 60 * 10; // 10 minutes

export async function GET() {
  if (!whoopOAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Whoop OAuth not configured. Set WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, WHOOP_REDIRECT_URI.",
      },
      { status: 500 }
    );
  }
  const state = randomBytes(24).toString("hex");
  const url = buildAuthorizeUrl(state);
  const res = NextResponse.redirect(url);
  res.cookies.set({
    name: STATE_COOKIE,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
