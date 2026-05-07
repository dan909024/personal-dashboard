/**
 * GET /harley/verify?t=<token>
 *
 * Consumes a magic-link token: validates not-already-used + not-expired,
 * marks the token used, signs a 24h JWT, drops it as the harley_session
 * httpOnly cookie, and 302s to /harley.
 *
 * Implemented as a Route Handler (not a Page) so we can mutate cookies
 * during the response cycle.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appendMagicLinkAudit,
  findMagicLink,
  markMagicLinkUsed,
} from "@/lib/sheets";
import { signJWT } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_TTL_SECONDS = 24 * 60 * 60;

function failResponse(message: string, status = 401): NextResponse {
  const body = `<!doctype html><html><head><title>Access denied</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#0a0a0a;color:#e4e4e7;font-family:system-ui;padding:2rem"><p style="font-size:0.75rem;letter-spacing:0.15em;text-transform:uppercase;color:#fda4af;margin-bottom:0.5rem">Access denied</p><p style="font-size:0.875rem">${message}</p></body></html>`;
  return new NextResponse(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || "unknown";
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") || "";
  const ip = clientIp(req);
  if (!token) return failResponse("Missing token.");

  const link = await findMagicLink(token);
  if (!link) {
    await appendMagicLinkAudit(ip, "verify_fail", "not_found");
    return failResponse("Invalid link.");
  }
  if (link.usedAt) {
    await appendMagicLinkAudit(ip, "verify_fail", "already_used");
    return failResponse("Link already used. Request a new one.");
  }
  const expMs = Date.parse(link.expiresAt);
  if (isNaN(expMs) || expMs < Date.now()) {
    await appendMagicLinkAudit(ip, "verify_fail", "expired");
    return failResponse("Link expired. Request a new one.");
  }

  const secret = process.env.HARLEY_JWT_SECRET || "";
  if (!secret) {
    await appendMagicLinkAudit(ip, "verify_fail", "jwt_secret_missing");
    return failResponse("Server not configured.", 500);
  }

  await markMagicLinkUsed(token);
  await appendMagicLinkAudit(ip, "verify_success", "");

  const jwt = signJWT({ sub: "harley" }, secret, SESSION_TTL_SECONDS);
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host") || "";
  const res = NextResponse.redirect(`${proto}://${host}/harley`, 302);
  res.cookies.set({
    name: "harley_session",
    value: jwt,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
