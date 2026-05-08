/**
 * POST /api/dashboard/sync/trigger — Daniel's on-demand "sync now"
 * button on the main dashboard.
 *
 * Different from /api/sync/trigger (the Harley flow):
 *   - No JWT auth. Dashboard URL is essentially private; the only
 *     thing this endpoint does is trigger an idempotent re-pull and
 *     bust caches. Whoop's own rate limit caps abuse at the API
 *     layer.
 *   - Soft IP rate limit (1 press / 60s) backed by the existing
 *     "Sync Triggers" Sheet tab. Source=dashboard so we can split
 *     audits later.
 *   - No email notification — Daniel is on the dashboard and sees
 *     the result inline.
 *   - Calls revalidatePath('/') after sync so the next render reads
 *     the fresh sheet rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { runWhoopSync } from "@/lib/whoop-sync";
import { appendSyncTrigger, getMostRecentSyncTriggerForIp } from "@/lib/sheets";
import { sendDanTelegram, formatSyncManualAsksMessage } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_MS = 60 * 1000;

const MANUAL_ASKS = [
  "Apple Health iOS Shortcut — tap play",
  "Screen Time Mac launchd — auto every 4h, force with: launchctl kickstart -k gui/$(id -u)/com.danielferrari.screentime-sync",
] as const;

type SyncResponse = {
  ok: boolean;
  whoop: "ok" | "error" | "not_connected" | "not_configured";
  whoopDetail?: string;
  manualAsks: string[];
  syncedAt: string;
};

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(
  req: NextRequest
): Promise<NextResponse<SyncResponse | { error: string; retryAfterSec?: number }>> {
  const ip = clientIp(req);

  // Rate limit: same IP + source can press once per minute.
  const lastIso = await getMostRecentSyncTriggerForIp(ip, "dashboard");
  if (lastIso) {
    const lastMs = Date.parse(lastIso);
    if (Number.isFinite(lastMs)) {
      const elapsedMs = Date.now() - lastMs;
      if (elapsedMs < RATE_LIMIT_MS) {
        const retryAfterSec = Math.ceil((RATE_LIMIT_MS - elapsedMs) / 1000);
        return NextResponse.json(
          { error: `rate_limited; retry in ${retryAfterSec}s`, retryAfterSec },
          { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
        );
      }
    }
  }

  // Whoop sync (per-source try/catch — not a hard failure).
  let whoop: SyncResponse["whoop"] = "ok";
  let whoopDetail: string | undefined;
  try {
    const result = await runWhoopSync();
    if (result.ok) {
      whoop = "ok";
      const counts = result.results
        .map((r) => (r.error ? `${r.date} err` : `${r.date} ${r.action}`))
        .join(", ");
      whoopDetail = counts;
    } else if (result.reason === "not_configured") {
      whoop = "not_configured";
      whoopDetail = "Sheets env missing on server";
    } else if (result.reason === "not_connected") {
      whoop = "not_connected";
      whoopDetail = "Whoop OAuth not completed";
    } else {
      whoop = "error";
      const errs = result.results
        .filter((r) => r.error)
        .map((r) => `${r.date}: ${r.error}`);
      whoopDetail = errs.join("; ").slice(0, 300);
    }
  } catch (e) {
    whoop = "error";
    whoopDetail = (e as Error).message.slice(0, 300);
    console.error("[dashboard/sync] whoop sync threw:", whoopDetail);
  }

  const manualAsks = [...MANUAL_ASKS];

  // Audit row — never throws.
  await appendSyncTrigger({
    ip,
    whoop: whoop + (whoopDetail ? ` (${whoopDetail})` : ""),
    manualAsks,
    emailSent: false,
    source: "dashboard",
  });

  // Push the manual-asks list to Dan's Telegram so he sees the
  // reminder on his phone, not just inline. Failure here doesn't
  // affect the sync result — sendDanTelegram returns a result
  // rather than throwing.
  await sendDanTelegram(
    formatSyncManualAsksMessage({
      source: "dashboard",
      whoop,
      whoopDetail,
      manualAsks,
    })
  );

  // Bust the page cache so the next render reflects the freshly
  // upserted rows. Per-tile readers use unstable_cache with their
  // own TTLs; revalidatePath busts the parent page's cache and is
  // sufficient for the user-visible "refresh felt fresh" effect.
  revalidatePath("/");

  return NextResponse.json({
    ok: whoop === "ok",
    whoop,
    whoopDetail,
    manualAsks,
    syncedAt: new Date().toISOString(),
  });
}
