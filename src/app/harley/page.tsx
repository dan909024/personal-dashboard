/**
 * Harley admin page — Goddess control panel.
 *
 * Auth: httpOnly JWT cookie `harley_session` signed with HARLEY_JWT_SECRET.
 * The cookie is issued by /harley/verify after consuming a Telegram
 * magic-link token (see /api/harley/login-request).
 *
 * The legacy ?token= query-string auth has been removed. If the cookie
 * is missing or invalid, we render <LoginButton /> instead.
 */
import { cookies } from "next/headers";
import { readDenialEndDate, getWeaknessSettings } from "@/lib/sheets";
import { verifyJWT } from "@/lib/jwt";
import { HarleyForm } from "./HarleyForm";
import { LoginButton } from "./LoginButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function HarleyAdminPage() {
  const c = await cookies();
  const sessionCookie = c.get("harley_session");
  const secret = process.env.HARLEY_JWT_SECRET || "";

  let authed = false;
  if (sessionCookie && secret) {
    const v = verifyJWT(sessionCookie.value, secret);
    if (v.ok && v.payload.sub === "harley") authed = true;
  }

  if (!authed) {
    return <LoginButton />;
  }

  const [endDate, settings] = await Promise.all([
    readDenialEndDate(),
    getWeaknessSettings(),
  ]);

  return <HarleyForm endDate={endDate} allowed={settings.orgasm_allowed} />;
}
