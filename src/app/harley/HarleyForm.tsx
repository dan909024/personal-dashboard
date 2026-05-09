"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { HARLEY_RULES, type HarleyRuleId } from "@/lib/harley-rules";
import type { GoddessAuditEntry, PunishmentWithRow } from "@/lib/sheets";
import type { HarleyRuleStatus } from "@/lib/harley-meter";
import {
  addCalendarTaskAction,
  addFineAction,
  clearAllUnpaidFinesAction,
  clearDenialAction,
  extendDenialAction,
  markFinePaidAction,
  messageDanielAction,
  setDenialDateAction,
  setHardModeAction,
  setOrgasmAllowedAdminAction,
  voidFineAction,
} from "./actions";

type ActionResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: true; newEndDate: string }
  | { ok: true; cleared: number }
  | { ok: true; finalAmount: number; doubled: boolean }
  | { ok: true; eventId: string; htmlLink: string | null };

type SyncResult = {
  ok: boolean;
  whoop: "ok" | "error" | "not_connected" | "not_configured";
  whoopDetail?: string;
  manualAsks: string[];
  emailSent: boolean;
};

const QUICK_FINE_AMOUNTS = [5, 10, 25, 50, 100, 200] as const;

export function HarleyForm({
  endDate,
  allowed,
  owedHarley,
  recentFines,
  hardMode,
  denialStartedAt,
  harleyMeter,
  ruleDetail,
  calendarConfigured,
  auditEntries,
}: {
  endDate: string | null;
  allowed: "yes" | "no";
  owedHarley: number;
  recentFines: PunishmentWithRow[];
  hardMode: boolean;
  denialStartedAt: string | null;
  harleyMeter: number;
  ruleDetail: HarleyRuleStatus[];
  calendarConfigured: boolean;
  auditEntries: GoddessAuditEntry[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [absoluteDate, setAbsoluteDate] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | { error: string } | null>(null);
  const [customFine, setCustomFine] = useState("");
  const [fineReason, setFineReason] = useState("");
  const [fineRule, setFineRule] = useState<HarleyRuleId | "">("");
  // Two-stage confirm: which destructive action is "armed" (one tap from
  // firing). Resets on a 4s timeout or after the action runs.
  const [armed, setArmed] = useState<string | null>(null);
  const [messageBody, setMessageBody] = useState("");
  const [messageSending, setMessageSending] = useState(false);
  const [calendarSummary, setCalendarSummary] = useState("");
  const [calendarWhen, setCalendarWhen] = useState("");

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const run = (label: string, fn: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        flash(`${label} ✓`);
        router.refresh();
      } else {
        flash(`Error: ${(res as { error: string }).error}`);
      }
    });
  };

  const onAdd = (hours: number, label: string) => {
    run(label, () => extendDenialAction(hours));
  };

  const onApplyDate = () => {
    if (!absoluteDate) {
      flash("Pick a date first");
      return;
    }
    run("Date set", () => setDenialDateAction(absoluteDate));
  };

  // Two-stage confirm: first click arms the action, second within 4s fires.
  const armOrFire = (key: string, fire: () => void) => {
    if (armed === key) {
      setArmed(null);
      fire();
    } else {
      setArmed(key);
      setTimeout(() => {
        setArmed((cur) => (cur === key ? null : cur));
      }, 4000);
    }
  };

  const onClear = () => {
    armOrFire("clear", () => run("Cleared", () => clearDenialAction()));
  };

  const onAllow = () => {
    armOrFire("allow", () =>
      run("Allowed", () => setOrgasmAllowedAdminAction("yes"))
    );
  };

  const onDeny = () => {
    armOrFire("deny", () =>
      run("Denied", () => setOrgasmAllowedAdminAction("no"))
    );
  };

  const onAddFine = (amount: number) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      flash("Pick an amount");
      return;
    }
    run(`Fined $${amount}`, () =>
      addFineAction(amount, fineReason, fineRule).then((r) => {
        if (r.ok) {
          setCustomFine("");
          setFineReason("");
          setFineRule("");
        }
        return r;
      })
    );
  };

  const onCustomFine = () => {
    const n = Number(customFine);
    if (!Number.isFinite(n) || n <= 0) {
      flash("Enter a positive number");
      return;
    }
    onAddFine(n);
  };

  const onMarkPaid = (rowIndex: number, label: string) => {
    run(`Paid: ${label}`, () => markFinePaidAction(rowIndex));
  };

  const onVoidFine = (rowIndex: number, label: string) => {
    armOrFire(`void:${rowIndex}`, () =>
      run(`Voided "${label}"`, () => voidFineAction(rowIndex))
    );
  };

  const onClearAllUnpaid = () => {
    armOrFire("reset-balance", () =>
      run("Balance reset", () => clearAllUnpaidFinesAction())
    );
  };

  const onToggleHardMode = () => {
    armOrFire(hardMode ? "hardmode-off" : "hardmode-on", () =>
      run(
        hardMode ? "Hard mode off" : "Hard mode ON",
        () => setHardModeAction(!hardMode)
      )
    );
  };

  const onAddCalendarTask = () => {
    if (!calendarSummary.trim()) {
      flash("Task title?");
      return;
    }
    if (!calendarWhen) {
      flash("Pick a date/time");
      return;
    }
    run("Task added ✓", () =>
      addCalendarTaskAction(calendarSummary, calendarWhen).then((r) => {
        if (r.ok) {
          setCalendarSummary("");
          setCalendarWhen("");
        }
        return r;
      })
    );
  };

  const onPrefillFineForRule = (ruleId: HarleyRuleId, label: string) => {
    setFineRule(ruleId);
    setFineReason(label);
    flash(`Prefilled: ${label}`);
  };

  const onMessageDaniel = async () => {
    const text = messageBody.trim();
    if (!text) {
      flash("Type a message first");
      return;
    }
    setMessageSending(true);
    try {
      const res = await messageDanielAction(text);
      if (res.ok) {
        flash(res.sent ? "Sent ✓" : "Saved (Telegram not configured)");
        setMessageBody("");
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e) {
      flash(`Failed: ${(e as Error).message}`);
    } finally {
      setMessageSending(false);
    }
  };

  const onSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync/trigger", { method: "POST" });
      const body = (await res.json()) as SyncResult | { error: string };
      setSyncResult(body);
      if ("ok" in body && body.ok) {
        flash("Synced ✓");
      } else if ("error" in body) {
        flash(`Sync error: ${body.error}`);
      } else {
        flash("Sync had issues — see details");
      }
    } catch (e) {
      const msg = (e as Error).message;
      setSyncResult({ error: msg });
      flash(`Sync failed: ${msg}`);
    } finally {
      setSyncing(false);
    }
  };

  const summary = describeEndDate(endDate);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-5">
      <div className="max-w-md mx-auto">
        <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase">
          Goddess Control Panel
        </p>
        <p className="text-sm text-zinc-400 mt-1 mb-5">
          Set or extend his denial. He cannot see this page.
        </p>

        {/* Current state */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
            Current state
          </p>

          {/* Status pill — visually dominant */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <div
              className={`flex items-center gap-2 ${
                allowed === "yes" ? "text-emerald-300" : "text-rose-300"
              }`}
            >
              <span className="text-2xl leading-none">●</span>
              <span className="text-2xl font-bold uppercase tracking-wider">
                {allowed === "yes" ? "Allowed" : "Denied"}
              </span>
              {allowed === "no" && denialStartedAt && (
                <span
                  className="text-xs text-zinc-500 ml-1"
                  title={denialStartedAt}
                >
                  · {daysSince(denialStartedAt)}d
                </span>
              )}
            </div>
            {hardMode && (
              <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest border border-amber-500 bg-amber-950/60 text-amber-200">
                Hard mode
              </span>
            )}
          </div>

          {/* Countdown — promoted to hero */}
          {summary ? (
            <p className="text-lg font-semibold text-zinc-100">{summary}</p>
          ) : (
            <p className="text-sm text-zinc-500 italic">No target set.</p>
          )}
          {endDate && (
            <p className="text-xs text-zinc-500 mt-0.5" title={endDate}>
              {humanizeEndDate(endDate)}
            </p>
          )}

          {/* Stats row */}
          <div className="mt-3 pt-3 border-t border-purple-900/40 grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-zinc-500">
                Owed Harley
              </p>
              <p
                className={`font-mono text-lg font-semibold tabular-nums ${
                  owedHarley > 0 ? "text-amber-300" : "text-emerald-300"
                }`}
              >
                ${owedHarley.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-zinc-500">
                Harley Meter
              </p>
              <p
                className={`font-mono text-lg font-semibold tabular-nums ${
                  harleyMeter >= 80
                    ? "text-emerald-300"
                    : harleyMeter >= 50
                    ? "text-amber-300"
                    : "text-rose-300"
                }`}
              >
                {harleyMeter}
                <span className="text-zinc-600 text-sm">/100</span>
              </p>
            </div>
          </div>
        </div>

        {/* Quick add */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Add time
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Adds to the current target if still future, otherwise to now.
          </p>
          <div className="grid grid-cols-4 gap-2">
            <QuickButton onClick={() => onAdd(1, "+1 hour")} disabled={isPending}>
              +1 hr
            </QuickButton>
            <QuickButton onClick={() => onAdd(12, "+12 hours")} disabled={isPending}>
              +12 hr
            </QuickButton>
            <QuickButton onClick={() => onAdd(24, "+1 day")} disabled={isPending}>
              +1 day
            </QuickButton>
            <QuickButton onClick={() => onAdd(72, "+3 days")} disabled={isPending}>
              +3 days
            </QuickButton>
            <QuickButton onClick={() => onAdd(168, "+1 week")} disabled={isPending}>
              +1 wk
            </QuickButton>
            <QuickButton onClick={() => onAdd(336, "+2 weeks")} disabled={isPending}>
              +2 wks
            </QuickButton>
            <QuickButton onClick={() => onAdd(720, "+1 month")} disabled={isPending}>
              +1 mo
            </QuickButton>
            <QuickButton onClick={() => onAdd(2160, "+3 months")} disabled={isPending}>
              +3 mo
            </QuickButton>
          </div>
        </div>

        {/* Override */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
            Override
          </p>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <button
              type="button"
              onClick={onAllow}
              disabled={isPending || allowed === "yes"}
              className={`px-3 py-2 text-xs font-semibold uppercase tracking-widest border transition-colors disabled:opacity-40 ${
                armed === "allow"
                  ? "border-emerald-300 bg-emerald-900/70 text-emerald-100"
                  : "border-emerald-700 bg-emerald-950/40 text-emerald-200 hover:border-emerald-400 hover:bg-emerald-900/60"
              }`}
            >
              {armed === "allow" ? "Tap again ✓" : "Allow now"}
            </button>
            <button
              type="button"
              onClick={onDeny}
              disabled={isPending || allowed === "no"}
              className={`px-3 py-2 text-xs font-semibold uppercase tracking-widest border transition-colors disabled:opacity-40 ${
                armed === "deny"
                  ? "border-rose-300 bg-rose-900/70 text-rose-100"
                  : "border-rose-700 bg-rose-950/40 text-rose-200 hover:border-rose-400 hover:bg-rose-900/60"
              }`}
            >
              {armed === "deny" ? "Tap again ✓" : "Deny now"}
            </button>
          </div>
          <button
            type="button"
            onClick={onClear}
            disabled={isPending}
            className={`w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border transition-colors disabled:opacity-50 ${
              armed === "clear"
                ? "border-amber-400 bg-amber-950/40 text-amber-200"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"
            }`}
          >
            {armed === "clear" ? "Tap again to clear target" : "Clear denial target"}
          </button>
        </div>

        {/* At-risk rules */}
        {ruleDetail.length > 0 && (
          <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
            <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
              Rule status · this week
            </p>
            <p className="text-[11px] text-zinc-500 mb-3 italic">
              Tap a failing rule to prefill a fine for it.
            </p>
            <ul className="space-y-1">
              {ruleDetail.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      r.state === "met"
                        ? "bg-emerald-400"
                        : r.state === "at-risk"
                        ? "bg-amber-400"
                        : "bg-rose-400"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => onPrefillFineForRule(r.id, r.label)}
                    disabled={isPending}
                    className={`flex-1 text-left truncate hover:text-white transition-colors ${
                      r.state === "met" ? "text-zinc-500" : "text-zinc-300"
                    }`}
                  >
                    {r.label}
                  </button>
                  <span className="font-mono tabular-nums text-zinc-500 w-10 text-right">
                    {Math.round(r.score * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Fines */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Fines
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Adds a row to Punishments. Optional reason + rule attach
            provenance. The OWED HARLEY tile updates within a minute.
            {hardMode && (
              <span className="text-amber-300"> Hard mode 2× ON.</span>
            )}
          </p>

          {/* Quick amounts */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {QUICK_FINE_AMOUNTS.map((n) => (
              <QuickButton
                key={n}
                onClick={() => onAddFine(n)}
                disabled={isPending}
              >
                ${n}
              </QuickButton>
            ))}
          </div>

          {/* Custom amount */}
          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="1"
                step="1"
                placeholder="Custom"
                value={customFine}
                onChange={(e) => setCustomFine(e.target.value)}
                className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 pl-6 pr-2 py-2 focus:outline-none focus:border-purple-500"
              />
            </div>
            <button
              type="button"
              onClick={onCustomFine}
              disabled={isPending || !customFine}
              className="px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-40"
            >
              Fine
            </button>
          </div>

          {/* Reason + rule */}
          <input
            type="text"
            value={fineReason}
            onChange={(e) => setFineReason(e.target.value)}
            placeholder="Reason (optional)"
            maxLength={200}
            className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 px-2 py-2 mb-2 focus:outline-none focus:border-purple-500"
          />
          <select
            value={fineRule}
            onChange={(e) => setFineRule(e.target.value as HarleyRuleId | "")}
            className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 px-2 py-2 mb-3 focus:outline-none focus:border-purple-500 [color-scheme:dark]"
          >
            <option value="">Manual fine (no rule)</option>
            {(Object.keys(HARLEY_RULES) as HarleyRuleId[]).map((id) => (
              <option key={id} value={id}>
                {HARLEY_RULES[id].label}
              </option>
            ))}
          </select>

          {/* Forgiveness — show mercy to Dan for his failings as a man.
              Auto fines (rule-eval cron + monthly fee) get their own
              subsection so it's obvious which were earned by failure
              versus delivered by your hand. */}
          {recentFines.length > 0 ? (
            <div className="border-t border-purple-900/40 pt-3">
              <p className="text-[10px] font-bold tracking-widest text-purple-300 uppercase mb-1">
                Forgiveness
              </p>
              <p className="text-[11px] text-zinc-500 italic mb-3">
                Show mercy to Dan for his failings as a man.
              </p>
              {(() => {
                const auto = recentFines.filter((f) => f.setBy === "auto");
                const manual = recentFines.filter((f) => f.setBy !== "auto");
                return (
                  <div className="space-y-3">
                    {auto.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase mb-1.5">
                          Auto fines · {auto.length}
                          <span className="font-normal italic text-zinc-600 normal-case tracking-normal ml-1">
                            (his failings)
                          </span>
                        </p>
                        <ul className="space-y-1.5">
                          {auto.map((f) => (
                            <FineRow
                              key={f.rowIndex}
                              fine={f}
                              disabled={isPending}
                              voidArmed={armed === `void:${f.rowIndex}`}
                              onMarkPaid={onMarkPaid}
                              onVoid={onVoidFine}
                            />
                          ))}
                        </ul>
                      </div>
                    )}
                    {manual.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase mb-1.5">
                          Manual fines · {manual.length}
                          <span className="font-normal italic text-zinc-600 normal-case tracking-normal ml-1">
                            (delivered by your hand)
                          </span>
                        </p>
                        <ul className="space-y-1.5">
                          {manual.map((f) => (
                            <FineRow
                              key={f.rowIndex}
                              fine={f}
                              disabled={isPending}
                              voidArmed={armed === `void:${f.rowIndex}`}
                              onMarkPaid={onMarkPaid}
                              onVoid={onVoidFine}
                            />
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <p className="text-[11px] text-zinc-600 italic border-t border-purple-900/40 pt-3">
              No unpaid fines. He has been good.
            </p>
          )}

          {/* Reset balance */}
          <div className="border-t border-purple-900/40 mt-3 pt-3 space-y-2">
            <button
              type="button"
              onClick={onClearAllUnpaid}
              disabled={isPending || recentFines.length === 0}
              className={`w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border transition-colors disabled:opacity-40 ${
                armed === "reset-balance"
                  ? "border-rose-400 bg-rose-950/60 text-rose-200"
                  : "border-zinc-700 text-zinc-400 hover:border-rose-500 hover:text-rose-300"
              }`}
            >
              {armed === "reset-balance"
                ? "Tap again to confirm"
                : "Reset balance to $0"}
            </button>
          </div>
        </div>

        {/* Set absolute */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Set exact date
          </p>
          <input
            type="datetime-local"
            value={absoluteDate}
            onChange={(e) => setAbsoluteDate(e.target.value)}
            className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 p-2 mb-2 focus:outline-none focus:border-purple-500 [color-scheme:dark]"
          />
          <button
            type="button"
            onClick={onApplyDate}
            disabled={isPending}
            className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50"
          >
            Apply
          </button>
          <p className="text-[10px] text-zinc-500 mt-2">
            Time in Sydney. Replaces the current target.
          </p>
        </div>

        {/* Sync Now */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Sync now
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Pulls fresh Whoop data and emails Daniel a manual-asks list for the rest.
          </p>
          <button
            type="button"
            onClick={onSyncNow}
            disabled={syncing || isPending}
            className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {syncResult && (
            <div className="mt-3 text-[11px] text-zinc-300 font-mono">
              {"error" in syncResult ? (
                <p className="text-rose-300">Error: {syncResult.error}</p>
              ) : (
                <>
                  <p>
                    Whoop:{" "}
                    <span
                      className={
                        syncResult.whoop === "ok"
                          ? "text-emerald-300"
                          : "text-amber-300"
                      }
                    >
                      {syncResult.whoop}
                    </span>
                    {syncResult.whoopDetail && (
                      <span className="text-zinc-500"> · {syncResult.whoopDetail}</span>
                    )}
                  </p>
                  <p className="mt-1">
                    Daniel email:{" "}
                    <span className={syncResult.emailSent ? "text-emerald-300" : "text-amber-300"}>
                      {syncResult.emailSent ? "sent" : "not sent"}
                    </span>
                  </p>
                  <p className="mt-2 text-zinc-400">Manual asks emailed to Daniel:</p>
                  <ul className="mt-1 list-disc pl-4 text-zinc-400">
                    {syncResult.manualAsks.map((a, i) => (
                      <li key={i} className="break-words">{a}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {/* Add calendar task */}
        {calendarConfigured && (
          <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
            <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
              Add calendar task
            </p>
            <p className="text-[11px] text-zinc-500 mb-3 italic">
              Lands on Daniel’s shared calendar as a Harley-authored event.
              Counts toward the harley-tasks rule once its start time passes.
            </p>
            <input
              type="text"
              value={calendarSummary}
              onChange={(e) => setCalendarSummary(e.target.value)}
              placeholder="Task title (e.g. Send proof photo)"
              maxLength={200}
              className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 px-2 py-2 mb-2 focus:outline-none focus:border-purple-500"
            />
            <input
              type="datetime-local"
              value={calendarWhen}
              onChange={(e) => setCalendarWhen(e.target.value)}
              className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 p-2 mb-2 focus:outline-none focus:border-purple-500 [color-scheme:dark]"
            />
            <button
              type="button"
              onClick={onAddCalendarTask}
              disabled={isPending || !calendarSummary.trim() || !calendarWhen}
              className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50"
            >
              Create task
            </button>
            <p className="text-[10px] text-zinc-500 mt-2">
              Time in Sydney. 30-minute default duration.
            </p>
          </div>
        )}

        {/* Message Daniel */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">
            Message Daniel
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Goes to his Telegram, prefixed “🩷 Goddess:”.
          </p>
          <div className="flex flex-wrap gap-1 mb-3">
            {[
              "Edge for me now.",
              "Good boy.",
              "Disappointed.",
              "Knees, now.",
            ].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setMessageBody(t)}
                disabled={messageSending || isPending}
                className="px-2 py-1 text-[10px] uppercase tracking-widest border border-purple-900 text-zinc-400 hover:border-purple-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
              >
                {t}
              </button>
            ))}
          </div>
          <textarea
            value={messageBody}
            onChange={(e) => setMessageBody(e.target.value)}
            placeholder="Type a message…"
            rows={3}
            maxLength={4000}
            className="w-full text-sm bg-black/40 border border-purple-900 text-zinc-100 px-2 py-2 mb-2 focus:outline-none focus:border-purple-500 resize-none"
          />
          <button
            type="button"
            onClick={onMessageDaniel}
            disabled={messageSending || isPending || !messageBody.trim()}
            className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-40"
          >
            {messageSending ? "Sending…" : "Send to Daniel"}
          </button>
        </div>

        {/* Hard mode + audit log */}
        <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
            Hard mode
          </p>
          <p className="text-[11px] text-zinc-500 mb-3 italic">
            Doubles every fine while ON: manual fines you add here and any
            auto rule-eval fines that fire. Monthly fee is excluded.
          </p>
          <button
            type="button"
            onClick={onToggleHardMode}
            disabled={isPending}
            className={`w-full px-3 py-2 text-xs font-semibold uppercase tracking-widest border transition-colors disabled:opacity-50 ${
              hardMode
                ? armed === "hardmode-off"
                  ? "border-amber-300 bg-amber-900/70 text-amber-100"
                  : "border-amber-500 bg-amber-950/60 text-amber-200"
                : armed === "hardmode-on"
                ? "border-amber-300 bg-amber-900/70 text-amber-100"
                : "border-zinc-700 text-zinc-400 hover:border-amber-500 hover:text-amber-300"
            }`}
          >
            {hardMode
              ? armed === "hardmode-off"
                ? "Tap again to turn off"
                : "Hard mode is ON · turn off"
              : armed === "hardmode-on"
              ? "Tap again to enable"
              : "Enable hard mode"}
          </button>
        </div>

        {auditEntries.length > 0 && (
          <div className="border border-purple-900/60 bg-[#120c1a]/90 p-4 mb-5">
            <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
              Recent panel activity
            </p>
            <ul className="space-y-1 text-xs">
              {auditEntries.map((e, i) => (
                <li key={i} className="flex items-baseline gap-2">
                  <span className="text-zinc-600 font-mono tabular-nums w-12 shrink-0">
                    {timeAgo(e.timestamp)}
                  </span>
                  <span className="text-zinc-400 uppercase tracking-wider text-[10px] w-20 shrink-0">
                    {e.action}
                  </span>
                  <span className="text-zinc-300 truncate" title={e.detail}>
                    {e.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-purple-900 border border-purple-500 text-white text-sm rounded shadow-lg">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-3 text-xs font-semibold uppercase tracking-widest border border-purple-700 bg-purple-950/40 text-purple-200 hover:border-purple-400 hover:bg-purple-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function FineRow({
  fine,
  disabled,
  voidArmed,
  onMarkPaid,
  onVoid,
}: {
  fine: PunishmentWithRow;
  disabled?: boolean;
  voidArmed: boolean;
  onMarkPaid: (rowIndex: number, label: string) => void;
  onVoid: (rowIndex: number, label: string) => void;
}) {
  const ruleLabel = fine.ruleId ? HARLEY_RULES[fine.ruleId as HarleyRuleId]?.label : null;
  const label = fine.reason || ruleLabel || "Fine";
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="text-zinc-500 font-mono tabular-nums w-16 shrink-0">
        {fine.date.slice(5)}
      </span>
      <span className="font-mono tabular-nums text-amber-300 w-12 shrink-0">
        ${fine.amount}
      </span>
      <span className="flex-1 text-zinc-300 truncate" title={label}>
        {label}
        {ruleLabel && fine.reason && (
          <span className="text-zinc-600"> · {ruleLabel}</span>
        )}
      </span>
      <button
        type="button"
        onClick={() => onMarkPaid(fine.rowIndex, label)}
        disabled={disabled}
        title="Mark paid"
        className="px-2 py-1 text-[10px] uppercase tracking-widest border border-emerald-800 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-950/40 transition-colors disabled:opacity-40"
      >
        ✓
      </button>
      <button
        type="button"
        onClick={() => onVoid(fine.rowIndex, label)}
        disabled={disabled}
        title={voidArmed ? "Tap again to void" : "Void (delete row)"}
        className={`px-2 py-1 text-[10px] uppercase tracking-widest border transition-colors disabled:opacity-40 ${
          voidArmed
            ? "border-rose-400 bg-rose-950/60 text-rose-200"
            : "border-zinc-700 text-zinc-500 hover:border-rose-500 hover:text-rose-300"
        }`}
      >
        {voidArmed ? "↺" : "✕"}
      </button>
    </li>
  );
}

function describeEndDate(endDate: string | null): string | null {
  if (!endDate) return null;
  const ms = Date.parse(endDate);
  if (isNaN(ms)) return "Unparseable target.";
  const diff = ms - Date.now();
  if (diff <= 0) return "Target has passed.";
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days >= 1) return `${days}d ${hours}h from now`;
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m from now`;
}

/**
 * "Sat 6 Jun · 11:50 PM Sydney" — human-readable Sydney wall-clock.
 * Source endDate is an ISO with offset; Intl picks up the moment-in-time
 * and renders in the Australia/Sydney zone regardless of the offset.
 */
function humanizeEndDate(endDate: string): string {
  const ms = Date.parse(endDate);
  if (isNaN(ms)) return endDate;
  const d = new Date(ms);
  const datePart = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
  const timePart = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${datePart} · ${timePart} Sydney`;
}

function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** "5m" / "2h" / "3d" — compact relative time for the audit list. */
function timeAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}
