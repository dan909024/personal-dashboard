/**
 * Weekly rules evaluator. Vercel cron fires Sunday 23:00 UTC =
 * Monday 09:00 AEST / 10:00 AEDT — early Monday Sydney, after the
 * just-ended Mon-Sun week is fully behind us. Daniel has all of
 * Sunday + Sunday night to rectify any data sync issues before
 * fines lock in.
 *
 * Behaviour:
 *   1. Resolve target week = the ISO week containing "yesterday Sydney"
 *      (i.e., the week that just ended).
 *   2. Read active rules from Rule Checks.
 *   3. Build the week's input (Whoop daily, workouts, Apple Health,
 *      screen time — with the same dedupe the dashboard uses).
 *   4. Run evaluateWeek(); for each rule with fineAmount > 0, append
 *      one Punishments row idempotently (Reason text encodes ruleId
 *      + week, so re-runs no-op).
 *
 * Manual override:
 *   /api/cron/rules-evaluate-week?secret=<CRON_SECRET>&week=2026-W18
 *   /api/cron/rules-evaluate-week?secret=<CRON_SECRET>&dry=1
 */
import { NextRequest, NextResponse } from "next/server";
import {
  appendPunishmentIfMissing,
  getRuleChecks,
  isConfigured,
} from "@/lib/sheets";
import {
  daysOfWeek,
  evaluateWeek,
  isoWeekContaining,
  sydneyTodayISO,
  weekId as makeWeekId,
} from "@/lib/rules";
import { buildWeekInput } from "@/lib/rules-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") || "";
  const queryParam = req.nextUrl.searchParams.get("secret") || "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : queryParam;
  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: "bad cron secret" }, { status: 401 });
  }

  if (!isConfigured()) {
    return NextResponse.json({ ok: false, error: "Sheets not configured" }, { status: 500 });
  }

  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const weekArg = req.nextUrl.searchParams.get("week"); // optional override "2026-W18"

  const target = resolveWeek(weekArg);
  const days = daysOfWeek(target.monday);

  const rules = await getRuleChecks();
  const activeRules = rules.filter((r) => r.active);
  if (activeRules.length === 0) {
    return NextResponse.json({
      ok: true,
      week: target.weekId,
      monday: target.monday,
      sunday: target.sunday,
      message: "no active rules — nothing to evaluate",
      rules_total: rules.length,
    });
  }

  const input = await buildWeekInput({ weekId: target.weekId, days });
  const outcomes = evaluateWeek(activeRules, input);

  const results: {
    ruleId: string;
    fineAmount: number;
    summary: string;
    appended: boolean;
  }[] = [];

  for (const o of outcomes) {
    if (o.fineAmount > 0) {
      if (dryRun) {
        results.push({ ruleId: o.ruleId, fineAmount: o.fineAmount, summary: o.summary, appended: false });
      } else {
        const { appended } = await appendPunishmentIfMissing(
          target.sunday, // anchor fine date to end of week
          o.fineAmount,
          o.reasonText,
          "rules-evaluate-week"
        );
        results.push({ ruleId: o.ruleId, fineAmount: o.fineAmount, summary: o.summary, appended });
      }
    } else {
      results.push({ ruleId: o.ruleId, fineAmount: 0, summary: o.summary, appended: false });
    }
  }

  const totalFines = results.reduce((s, r) => s + r.fineAmount, 0);
  return NextResponse.json({
    ok: true,
    week: target.weekId,
    monday: target.monday,
    sunday: target.sunday,
    dryRun,
    rules_active: activeRules.length,
    totalFines,
    results,
  });
}

function resolveWeek(arg: string | null): {
  weekId: string;
  monday: string;
  sunday: string;
} {
  if (arg) {
    const m = arg.match(/^(\d{4})-W(\d{1,2})$/);
    if (m) {
      const yr = Number(m[1]);
      const wk = Number(m[2]);
      const jan4 = new Date(Date.UTC(yr, 0, 4));
      const jan4Day = jan4.getUTCDay() || 7;
      const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400 * 1000);
      const monday = new Date(week1Monday.getTime() + (wk - 1) * 7 * 86400 * 1000)
        .toISOString().slice(0, 10);
      const w = isoWeekContaining(monday);
      return { weekId: makeWeekId(w.year, w.week), monday: w.monday, sunday: w.sunday };
    }
  }
  // Default: the week containing yesterday Sydney = the just-ended week.
  const today = sydneyTodayISO();
  const ms = Date.parse(today + "T12:00:00Z") - 86400 * 1000;
  const yesterday = new Date(ms).toISOString().slice(0, 10);
  const w = isoWeekContaining(yesterday);
  return { weekId: makeWeekId(w.year, w.week), monday: w.monday, sunday: w.sunday };
}
