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
import {
  getHarleyBalance,
  getRecentGoddessAudit,
  getRecentUnpaidPunishments,
  getSetting,
  getWeaknessSettings,
  isConfigured,
  readDenialEndDate,
} from "@/lib/sheets";
import {
  getHarleyMeter,
  getHarleyMeterDetail,
  type HarleyRuleStatus,
} from "@/lib/harley-meter";
import { isCalendarConfigured } from "@/lib/calendar";
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

  const configured = isConfigured();
  const [
    endDate,
    settings,
    balance,
    recentFines,
    doubleNextMonthRaw,
    hardModeRaw,
    denialStartedAtRaw,
    meter,
    ruleDetail,
    auditEntries,
  ] = await Promise.all([
    readDenialEndDate(),
    getWeaknessSettings(),
    getHarleyBalance(),
    getRecentUnpaidPunishments(10),
    getSetting("double_next_month"),
    getSetting("hard_mode"),
    getSetting("denial_started_at"),
    configured ? getHarleyMeter() : Promise.resolve(0),
    configured
      ? getHarleyMeterDetail()
      : Promise.resolve([] as HarleyRuleStatus[]),
    getRecentGoddessAudit(5),
  ]);

  const doubleNextMonth =
    String(doubleNextMonthRaw ?? "").trim().toLowerCase() === "yes";
  const hardMode =
    String(hardModeRaw ?? "").trim().toLowerCase() === "yes";
  const denialStartedAt =
    typeof denialStartedAtRaw === "string" && denialStartedAtRaw.trim()
      ? denialStartedAtRaw.trim()
      : null;

  return (
    <HarleyForm
      endDate={endDate}
      allowed={settings.orgasm_allowed}
      owedHarley={balance.owed}
      recentFines={recentFines}
      doubleNextMonth={doubleNextMonth}
      hardMode={hardMode}
      denialStartedAt={denialStartedAt}
      harleyMeter={meter}
      ruleDetail={ruleDetail}
      calendarConfigured={isCalendarConfigured()}
      auditEntries={auditEntries}
    />
  );
}
