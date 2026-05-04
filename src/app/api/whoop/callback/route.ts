import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, saveInitialTokens, whoopOAuthConfigured } from "@/lib/whoop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "whoop_oauth_state";

export async function GET(req: NextRequest) {
  if (!whoopOAuthConfigured()) {
    return NextResponse.json(
      { error: "Whoop OAuth not configured." },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    const desc = url.searchParams.get("error_description") || "";
    return redirectHome(req, `whoop_error=${encodeURIComponent(errorParam)}&whoop_error_desc=${encodeURIComponent(desc)}`);
  }

  if (!code || !state) {
    return redirectHome(req, "whoop_error=missing_code_or_state");
  }

  const cookieState = req.cookies.get(STATE_COOKIE)?.value;
  if (!cookieState || cookieState !== state) {
    return redirectHome(req, "whoop_error=state_mismatch");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveInitialTokens(tokens);
  } catch (e) {
    console.error("[whoop callback] token exchange failed:", (e as Error).message);
    return redirectHome(req, `whoop_error=${encodeURIComponent("token_exchange_failed")}`);
  }

  const res = redirectHome(req, "whoop=connected");
  // Clear the state cookie
  res.cookies.set({ name: STATE_COOKIE, value: "", maxAge: 0, path: "/" });
  return res;
}

function redirectHome(req: NextRequest, query: string): NextResponse {
  const u = new URL("/", req.url);
  u.search = query;
  return NextResponse.redirect(u);
}
