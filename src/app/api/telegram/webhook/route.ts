/**
 * POST /api/telegram/webhook
 *
 * Inbound Telegram updates. Flows handled:
 *
 *   /start                   → replies with `chat_id: <id>` so
 *                              TRIPWIRE_TELEGRAM_CHAT_ID etc. can be
 *                              bootstrapped once.
 *
 *   /info                    → cheat-sheet message listing every bot
 *                              command and every action available in
 *                              the Goddess Control Panel. Same auth
 *                              gate as /fine — we don't leak the
 *                              feature surface to random chats.
 *
 *   /fine <amount> <reason>  → appends a row to the Punishments sheet.
 *                              Manual fines (rule_id empty). Restricted
 *                              to authorized chat IDs:
 *                                - HARLEY_TELEGRAM_CHAT_ID env (Harley's DM)
 *                                - DAN_TELEGRAM_CHAT_ID env (Dan's DM)
 *                                - TRIPWIRE_TELEGRAM_CHAT_ID (bootstrap fallback)
 *                              Replies with confirmation or parse error.
 *
 *   /add <days>              → extends the Denial Tracker target by N days.
 *                              Same auth gate as /fine. Mirrors the panel's
 *                              extendDenialAction: extends the current target
 *                              if still future, otherwise starts a fresh
 *                              window from now. Replies with the new release
 *                              datetime.
 *
 *   photo                    → if the SENDER is HARLEY_TELEGRAM_USER_ID
 *                              (falling back to HARLEY_TELEGRAM_CHAT_ID),
 *                              uploads the photo to Vercel Blob under
 *                              coach/<timestamp>.<ext>. Photos over 4.5MB
 *                              are dropped. No reply either way.
 *
 * Anything else is silently ignored.
 *
 * Set the webhook with:
 *   curl -F "url=https://<prod>/api/telegram/webhook" \
 *        -F "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
 *        https://api.telegram.org/bot<TOKEN>/setWebhook
 *
 * If TELEGRAM_WEBHOOK_SECRET is set, requests must carry the matching
 * x-telegram-bot-api-secret-token header — Telegram does this when
 * setWebhook is called with secret_token. If unset, the route accepts
 * unauthenticated POSTs (fine for the bootstrap window; lock it down by
 * setting the env var once the bot is in production use).
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { TRIPWIRE_TELEGRAM_CHAT_ID } from "@/lib/harley-auth";
import {
  DENIAL_END_DATE_TAG,
  appendGoddessAudit,
  appendPunishment,
  getHarleyBalance,
  getPunishments,
  getSetting,
  isConfigured,
  readDenialEndDate,
  setDenialEndDate,
  setSetting,
  todaySydneyISO,
} from "@/lib/sheets";
import {
  DEFAULT_FINE_AMOUNTS,
  HARLEY_RULES,
  fineAmountSettingKey,
  type HarleyRuleId,
} from "@/lib/harley-rules";
import {
  EDGES_DAILY_TARGET_KEY,
  LAST_SUNDAY_REVIEW_KEY,
  WORSHIP_DAILY_TARGET_MIN_KEY,
  currentOrPreviousSundayISO,
  getFineAmounts,
} from "@/lib/rule-eval";
import {
  WAKE_BY_MIN,
  BED_BY_MIN,
  STRAIN_TARGET_TRAINING_DAY,
  TRAINING_DAY_MIN_DURATION_MIN,
} from "@/lib/harley-meter";
import { uploadCoachPhoto } from "@/lib/coach-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel function request body cap. Photos larger than this are silently
// ignored — Harley doesn't get a reply by design, so a "too big" message
// would just be confusing.
const MAX_PHOTO_BYTES = 4_500_000;

type TelegramChat = { id: number; type: string };
type TelegramFrom = { id: number; first_name?: string; username?: string };
type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};
type TelegramMessage = {
  chat?: TelegramChat;
  from?: TelegramFrom;
  text?: string;
  photo?: TelegramPhotoSize[];
};
type TelegramUpdate = {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

async function reply(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("[telegram webhook] reply failed:", (e as Error).message);
  }
}

function parseEnvChatId(name: string): number | null {
  const raw = process.env[name] || "";
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function isAuthorizedFineChat(chatId: number): boolean {
  if (chatId === TRIPWIRE_TELEGRAM_CHAT_ID) return true;
  const harley = parseEnvChatId("HARLEY_TELEGRAM_CHAT_ID");
  if (harley && chatId === harley) return true;
  const dan = parseEnvChatId("DAN_TELEGRAM_CHAT_ID");
  if (dan && chatId === dan) return true;
  return false;
}

/**
 * Parse "/fine 45 phone over 90min" → { amount: 45, reason: "phone over 90min" }.
 * Bot-username suffix on the command (`/fine@bot`) is stripped. Returns
 * null when the format doesn't match — caller replies with usage.
 */
function parseFineCommand(text: string): { amount: number; reason: string } | null {
  const m = text.match(/^\/fine(?:@\w+)?\s+(\S+)\s+(.+)$/i);
  if (!m) return null;
  const amount = Number(m[1].replace(/[$,]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const reason = m[2].trim();
  if (!reason) return null;
  return { amount, reason };
}

/**
 * Parse "/add 7" or "/add 1.5" → 7 / 1.5 (days). Returns null if the
 * value is not a positive finite number. Caps at 365 to block fat-finger.
 */
function parseAddDaysCommand(text: string): number | null {
  const m = text.match(/^\/add(?:@\w+)?\s+(\S+)\s*$/i);
  if (!m) return null;
  const days = Number(m[1]);
  if (!Number.isFinite(days) || days <= 0 || days > 365) return null;
  return days;
}

function formatSydneyOffsetISO(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const datePart = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const tz = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00";
  return `${datePart}${tz.replace("GMT", "")}`;
}

// Cheat-sheet sent by /info. Stays under Telegram's 4096-char text limit.
// Update this in lockstep with src/app/harley/HarleyForm.tsx so the panel
// description stays accurate as the panel evolves.
const INFO_TEXT = `🤖 BOT COMMANDS

/start — replies with this chat's ID.

/info — this list.

/rules — every active rule + its current $ amount.

/status — balance, hard-mode, this week's auto-fines,
  Sunday-review stamp.

/add <days> — extends Daniel's denial period by N days.
  Adds to the current target if still future, otherwise
  starts a fresh window from now. Cap: 365.
  Example: /add 7

/fine <amount> <reason> — adds a fine to Daniel's balance.
  Example: /fine 45 phone over 90min

/drank — Daniel logs a drink. Auto-fines at the
  drinking-rule amount ($100 default; respects hard-mode 2×).

/review — Daniel stamps the Sunday review for this
  week. Skip and rule-eval fines $30 at Mon 22:00 Sydney.

📷 photo (sent by Harley) — replaces Daniel's coach photo
  on the dashboard.

🌐 GODDESS CONTROL PANEL (/harley)

Live state
  • Allowed / Denied status with day counter
  • Countdown to release · Owed Harley · Harley Meter

Add time (quick buttons)
  • +1hr · +12hr · +1d · +3d · +1wk · +2wk · +1mo · +3mo

Override
  • Allow now · Deny now · Clear denial target
    (two-tap to fire)

Dan's last 7 days
  • Per-rule pass rate. Tap a failing rule to prefill a fine
    for it.

Fine schedule
  • Edit the auto-fine $ for each rule. Applies to future
    auto-fines and the Slipped button immediately.

Fines
  • Quick amounts: $5 / $10 / $25 / $50 / $100 / $200
  • Custom amount + optional reason + optional rule attach

Forgiveness
  • Mark any unpaid fine as paid, or void it (delete row)
  • Auto fines (his failings) and manual fines (your hand)
    are listed separately
  • Reset balance to $0 (two-tap)

Set exact date
  • Pick a Sydney date/time — replaces the current target

Sync now
  • Pulls fresh Whoop data and emails Daniel a manual-asks
    list for everything else

Add calendar task
  • Creates an event on Daniel's shared calendar; counts
    toward the harley-tasks rule once its start time passes

Message Daniel
  • Telegram DM, prefixed "🩷 Goddess:"
  • Presets: Edge for me now · Good boy · Disappointed ·
    Knees, now

Hard mode
  • Toggle: doubles every fine while ON. Monthly fee
    excluded.

Recent panel activity
  • Audit log of the last actions taken from the panel.`;

function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Live rules schedule for /rules. Pulls per-rule amounts from Settings (so
 * Harley's panel edits show up immediately) and surfaces worship/edges in
 * dormant/active form based on their daily-target sliders.
 */
async function buildRulesMessage(): Promise<string> {
  const [amounts, worshipTargetRaw, edgesTargetRaw] = await Promise.all([
    getFineAmounts(),
    getSetting(WORSHIP_DAILY_TARGET_MIN_KEY),
    getSetting(EDGES_DAILY_TARGET_KEY),
  ]);
  const worshipTarget = Number(worshipTargetRaw);
  const edgesTarget = Number(edgesTargetRaw);
  const worshipActive = amounts.worship > 0 && Number.isFinite(worshipTarget) && worshipTarget > 0;
  const edgesActive = amounts.edges > 0 && Number.isFinite(edgesTarget) && edgesTarget > 0;

  const lines: string[] = [];
  lines.push("📜 RULES SCHEDULE");
  lines.push("(Live amounts; Harley edits via /harley.)");
  lines.push("");
  lines.push("DAILY ($/failed day)");
  lines.push(`  wake ≤ ${fmtClock(WAKE_BY_MIN)}        $${amounts.wake}`);
  lines.push(`  bed ≤ ${fmtClock(BED_BY_MIN)}         $${amounts.bed}`);
  lines.push(
    `  strain ≥${STRAIN_TARGET_TRAINING_DAY} on training days  $${amounts.strain}`
  );
  lines.push(`  whoopdata (no Whoop sleep) $${amounts.whoopdata}`);
  lines.push(`  review (Sunday stamp)     $${amounts.review}`);
  lines.push(`  screentime (any bucket over) $${amounts.screentime}`);
  lines.push(
    `  worship · ${worshipActive ? `$${amounts.worship} · ${worshipTarget}min/day` : "dormant"}`
  );
  lines.push(
    `  edges · ${edgesActive ? `$${amounts.edges} · ${edgesTarget}/day` : "dormant"}`
  );
  lines.push("");
  lines.push("WEEKLY ($/eval Sun 22:00)");
  lines.push(`  gym 4+/wk            $${amounts.gym} × shortfall`);
  lines.push(`  steps 10k/day        $${amounts.steps} × days under`);
  lines.push(`  water 3.3L/day avg   $${amounts.water}`);
  lines.push(`  writing 8h Obsidian  $${amounts.writing}`);
  lines.push(`  protein 5+ days hit  $${amounts.protein}`);
  lines.push("");
  lines.push("MANUAL");
  lines.push(`  drinking · /drank or panel  $${amounts.drinking}`);
  lines.push(`  slip · WeaknessAltar btn    $${amounts.slip}`);
  lines.push("");
  lines.push("Training day = Whoop workout ≥" + TRAINING_DAY_MIN_DURATION_MIN + "min.");
  lines.push("Auto-fines fire daily 22:00 Sydney; idempotent on (rule, period).");
  return lines.join("\n");
}

/**
 * Live status for /status. Pulls balance, hard-mode, denial state, this
 * week's auto-fines, and Sunday-review stamp into a single snapshot.
 */
async function buildStatusMessage(): Promise<string> {
  const [
    balance,
    hardModeRaw,
    allowedRaw,
    denialEnd,
    weekFines,
    lastReview,
  ] = await Promise.all([
    getHarleyBalance(),
    getSetting("hard_mode"),
    getSetting("orgasm_allowed"),
    readDenialEndDate(),
    getPunishments(),
    getSetting(LAST_SUNDAY_REVIEW_KEY),
  ]);
  const hardMode = String(hardModeRaw ?? "").trim().toLowerCase() === "yes";
  const allowed = String(allowedRaw ?? "").trim().toLowerCase() === "yes";

  const today = todaySydneyISO();
  const sundayThisWeek = currentOrPreviousSundayISO(today);
  const reviewStamp = String(lastReview ?? "").trim();
  const reviewMet = reviewStamp >= sundayThisWeek;

  // Group this-week's fines by ruleId so a long list collapses to a tally.
  const autoFines = weekFines.filter((f) => f.setBy === "auto");
  const manualFines = weekFines.filter((f) => f.setBy !== "auto");
  const autoTotal = autoFines.reduce((s, f) => s + f.amount, 0);
  const manualTotal = manualFines.reduce((s, f) => s + f.amount, 0);
  const byRule = new Map<string, { count: number; total: number }>();
  for (const f of autoFines) {
    const key = f.ruleId || "?";
    const prev = byRule.get(key) ?? { count: 0, total: 0 };
    byRule.set(key, { count: prev.count + 1, total: prev.total + f.amount });
  }

  const lines: string[] = [];
  lines.push(`📊 STATUS · ${today}`);
  lines.push("");
  lines.push(`Balance: $${balance.owed.toLocaleString("en-AU")} owed`);
  lines.push(
    `State: ${allowed ? "✅ ALLOWED" : "🔒 DENIED"}${hardMode ? " · 🔥 hard-mode 2×" : ""}`
  );
  if (denialEnd) {
    const ms = Date.parse(denialEnd);
    if (!isNaN(ms)) {
      const diff = ms - Date.now();
      if (diff > 0) {
        const days = Math.floor(diff / 86_400_000);
        const hours = Math.floor((diff % 86_400_000) / 3_600_000);
        lines.push(`Release in ${days}d ${hours}h`);
      } else {
        lines.push("Release target has passed.");
      }
    }
  }
  lines.push("");
  lines.push("THIS WEEK (Mon–Sun)");
  if (autoFines.length === 0 && manualFines.length === 0) {
    lines.push("  No fines yet. Good boy.");
  } else {
    if (autoFines.length > 0) {
      lines.push(`  Auto: $${autoTotal} · ${autoFines.length} fine${autoFines.length === 1 ? "" : "s"}`);
      // Rank rules by $ this week.
      const ranked = [...byRule.entries()].sort((a, b) => b[1].total - a[1].total);
      for (const [ruleId, agg] of ranked) {
        const label = HARLEY_RULES[ruleId as HarleyRuleId]?.label ?? ruleId;
        lines.push(`    • ${label} · $${agg.total} (${agg.count})`);
      }
    }
    if (manualFines.length > 0) {
      lines.push(`  Manual: $${manualTotal} · ${manualFines.length} fine${manualFines.length === 1 ? "" : "s"}`);
    }
  }
  lines.push("");
  lines.push(
    `Sunday review (${sundayThisWeek}): ${reviewMet ? "✓ stamped" : "✗ NOT stamped"}`
  );
  if (!reviewMet) {
    lines.push("  Tap /review or the panel button before Mon 22:00 Sydney to avoid the $30 fine.");
  }
  return lines.join("\n");
}

function formatSydneyHuman(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (expectedSecret) {
    const provided = req.headers.get("x-telegram-bot-api-secret-token") || "";
    if (provided !== expectedSecret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  let body: TelegramUpdate;
  try {
    body = (await req.json()) as TelegramUpdate;
  } catch {
    // Telegram retries on non-2xx, so swallow malformed bodies cleanly.
    return NextResponse.json({ ok: true });
  }

  const message = body.message ?? body.channel_post;
  const chatId = message?.chat?.id;
  if (!chatId) return NextResponse.json({ ok: true });

  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";

  // Photo upload — Harley sends a picture, becomes the new dashboard coach
  // photo. Gated on the SENDER's user id, not the chat id, so it works
  // wherever the bot can see her photo (her DM with the bot today, a
  // shared group tomorrow). No confirmation reply by design.
  if (message?.photo && message.photo.length > 0) {
    await handleCoachPhoto(message.from?.id, message.photo, botToken);
    return NextResponse.json({ ok: true });
  }

  const text = (message?.text ?? "").trim();
  if (!text) return NextResponse.json({ ok: true });

  // /start can be plain or namespaced as `/start@bot_username`.
  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    if (botToken) {
      await reply(botToken, chatId, `chat_id: ${chatId}`);
    } else {
      console.warn("[telegram webhook] TELEGRAM_BOT_TOKEN missing — skipping reply.");
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/info" || text.startsWith("/info@")) {
    if (!isAuthorizedFineChat(chatId)) {
      return NextResponse.json({ ok: true });
    }
    if (botToken) await reply(botToken, chatId, INFO_TEXT);
    return NextResponse.json({ ok: true });
  }

  if (text === "/add" || text.startsWith("/add ") || text.startsWith("/add@")) {
    if (!isAuthorizedFineChat(chatId)) {
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    const days = parseAddDaysCommand(text);
    if (days === null) {
      if (botToken) {
        await reply(
          botToken,
          chatId,
          "Usage: /add <days>\nExample: /add 7"
        );
      }
      return NextResponse.json({ ok: true });
    }
    try {
      // Mirrors extendDenialAction: extend the active window if it's still
      // future, otherwise start a fresh window from now.
      const current = await readDenialEndDate();
      const nowMs = Date.now();
      let baseMs = nowMs;
      if (current) {
        const ms = Date.parse(current);
        if (!isNaN(ms) && ms > nowMs) baseMs = ms;
      }
      const newMs = baseMs + days * 86_400_000;
      const newEndDate = formatSydneyOffsetISO(new Date(newMs));
      await setDenialEndDate(newEndDate);
      await appendGoddessAudit("extend", `+${days}d → ${newEndDate} (Telegram)`);
      revalidateTag(DENIAL_END_DATE_TAG);
      revalidatePath("/");
      revalidatePath("/harley");
      if (botToken) {
        await reply(
          botToken,
          chatId,
          `🔒 +${days} day${days === 1 ? "" : "s"} added.\nNew release: ${formatSydneyHuman(newEndDate)}`
        );
      }
    } catch (e) {
      console.error("[telegram webhook] /add failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to extend denial. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/rules" || text.startsWith("/rules@")) {
    if (!isAuthorizedFineChat(chatId)) {
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    try {
      const msg = await buildRulesMessage();
      if (botToken) await reply(botToken, chatId, msg);
    } catch (e) {
      console.error("[telegram webhook] /rules failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to build rules. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/status" || text.startsWith("/status@")) {
    if (!isAuthorizedFineChat(chatId)) {
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    try {
      const msg = await buildStatusMessage();
      if (botToken) await reply(botToken, chatId, msg);
    } catch (e) {
      console.error("[telegram webhook] /status failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to build status. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/drank" || text.startsWith("/drank ") || text.startsWith("/drank@")) {
    if (!isAuthorizedFineChat(chatId)) {
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    try {
      const amountRaw = await getSetting(fineAmountSettingKey("drinking"));
      const parsed = Number(amountRaw);
      const fineAmount =
        Number.isFinite(parsed) && parsed > 0
          ? parsed
          : DEFAULT_FINE_AMOUNTS.drinking;
      const hardMode =
        String((await getSetting("hard_mode")) ?? "")
          .trim()
          .toLowerCase() === "yes";
      const finalAmount = hardMode ? fineAmount * 2 : fineAmount;
      const fromName = message?.from?.first_name || message?.from?.username || "Telegram";
      await appendPunishment({
        amount: finalAmount,
        reason: hardMode ? "Drank alcohol (hard-mode 2×)" : "Drank alcohol",
        setBy: `${fromName} (Telegram /drank)`,
        ruleId: "drinking",
      });
      revalidatePath("/");
      revalidatePath("/harley");
      if (botToken) {
        await reply(
          botToken,
          chatId,
          `🍷 Logged: drank alcohol — $${finalAmount}${hardMode ? " (hard-mode 2×)" : ""} added to balance.`
        );
      }
    } catch (e) {
      console.error("[telegram webhook] /drank append failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to log drink. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/review" || text.startsWith("/review ") || text.startsWith("/review@")) {
    if (!isAuthorizedFineChat(chatId)) {
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    try {
      const sunday = currentOrPreviousSundayISO(todaySydneyISO());
      await setSetting(LAST_SUNDAY_REVIEW_KEY, sunday, "telegram");
      revalidatePath("/");
      revalidatePath("/harley");
      if (botToken) {
        await reply(
          botToken,
          chatId,
          `✓ Sunday review stamped for ${sunday}. The review rule is satisfied for that week.`
        );
      }
    } catch (e) {
      console.error("[telegram webhook] /review failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to stamp review. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (text === "/fine" || text.startsWith("/fine ") || text.startsWith("/fine@")) {
    if (!isAuthorizedFineChat(chatId)) {
      // Stay quiet on unauthorized chats — don't leak that the command exists.
      return NextResponse.json({ ok: true });
    }
    if (!isConfigured()) {
      if (botToken) await reply(botToken, chatId, "❌ Sheets not configured.");
      return NextResponse.json({ ok: true });
    }
    const parsed = parseFineCommand(text);
    if (!parsed) {
      if (botToken) {
        await reply(
          botToken,
          chatId,
          "Usage: /fine <amount> <reason>\nExample: /fine 45 phone over 90min"
        );
      }
      return NextResponse.json({ ok: true });
    }
    const fromName = message?.from?.first_name || message?.from?.username || "Telegram";
    try {
      await appendPunishment({
        amount: parsed.amount,
        reason: parsed.reason,
        setBy: `${fromName} (Telegram)`,
        ruleId: "",
      });
      if (botToken) {
        await reply(
          botToken,
          chatId,
          `✅ Fine logged: $${parsed.amount} — ${parsed.reason}`
        );
      }
    } catch (e) {
      console.error("[telegram webhook] /fine append failed:", (e as Error).message);
      if (botToken) {
        await reply(botToken, chatId, "❌ Failed to log fine. Check server logs.");
      }
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

/**
 * Handle a Telegram photo message: download from Telegram and upload to
 * Vercel Blob under `coach/<timestamp>.<ext>`. Gate is the SENDER's user
 * id (HARLEY_TELEGRAM_USER_ID, falling back to HARLEY_TELEGRAM_CHAT_ID
 * since chat id == user id in a private DM with the bot). Photos over
 * MAX_PHOTO_BYTES are dropped. No replies. Errors are logged + swallowed
 * so Telegram doesn't retry the webhook.
 */
async function handleCoachPhoto(
  fromUserId: number | undefined,
  photo: TelegramPhotoSize[],
  botToken: string
): Promise<void> {
  if (!fromUserId) return;
  const harley =
    parseEnvChatId("HARLEY_TELEGRAM_USER_ID") ??
    parseEnvChatId("HARLEY_TELEGRAM_CHAT_ID");
  if (!harley || fromUserId !== harley) return;
  if (!botToken) {
    console.warn("[telegram webhook] coach-photo: TELEGRAM_BOT_TOKEN missing");
    return;
  }

  // Telegram sends photo at multiple resolutions. Pick the largest by area.
  // file_size is the early bail signal — the user wants the run to abort
  // entirely (not even download) when the photo is over the cap.
  const largest = photo.reduce((a, b) =>
    a.width * a.height >= b.width * b.height ? a : b
  );
  if (largest.file_size && largest.file_size > MAX_PHOTO_BYTES) {
    console.log(
      `[telegram webhook] coach-photo: skipping ${largest.file_size}B over ${MAX_PHOTO_BYTES}B`
    );
    return;
  }

  try {
    // getFile returns { file_path, file_size }. Recheck size here in case
    // the photo array entry didn't carry it.
    const fileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(largest.file_id)}`
    );
    if (!fileRes.ok) {
      console.error("[telegram webhook] coach-photo: getFile failed", fileRes.status);
      return;
    }
    const fileBody = (await fileRes.json()) as {
      ok: boolean;
      result?: { file_path?: string; file_size?: number };
    };
    const filePath = fileBody.result?.file_path;
    const fileSize = fileBody.result?.file_size;
    if (!filePath) {
      console.error("[telegram webhook] coach-photo: no file_path in getFile response");
      return;
    }
    if (fileSize && fileSize > MAX_PHOTO_BYTES) {
      console.log(
        `[telegram webhook] coach-photo: getFile reports ${fileSize}B over ${MAX_PHOTO_BYTES}B — skipping`
      );
      return;
    }

    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`
    );
    if (!downloadRes.ok) {
      console.error(
        "[telegram webhook] coach-photo: download failed",
        downloadRes.status
      );
      return;
    }
    const bytes = await downloadRes.arrayBuffer();
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      console.log(
        `[telegram webhook] coach-photo: actual bytes ${bytes.byteLength} over ${MAX_PHOTO_BYTES} — skipping`
      );
      return;
    }

    // Telegram delivers JPEGs for photo messages. Honor the file extension
    // anyway in case that ever changes.
    const extMatch = filePath.match(/\.([a-z0-9]{2,4})$/i);
    const ext = extMatch ? extMatch[1] : "jpg";

    const url = await uploadCoachPhoto(bytes, ext);
    console.log("[telegram webhook] coach-photo: uploaded", url);
  } catch (e) {
    console.error("[telegram webhook] coach-photo failed:", (e as Error).message);
  }
}
