import {
  getHarleyBalance,
  getWorshipTotals,
  getLatestWhoopDaily,
  isConfigured,
  isWhoopConnected,
  getDashboardSystemHealth,
  getRecentSleepEdits,
  getDashboardAppleHealth,
  getDashboardScreentime,
  getDashboardWhoopWorkouts,
  getDashboardTransactions,
  getDashboardNutrition,
  getDrinkingStats,
  getVideoStoreSpendMonth,
  type DrinkingStats,
  type SystemHealth,
  type VideoStoreSpend,
  type SleepEdit,
  type DashboardAppleHealth,
  type DashboardWhoopWorkouts,
  type DashboardTransactions,
  type DashboardNutrition,
  type ScreenTimeRow,
  type HarleyBalance,
  type WorshipTotals,
} from "@/lib/sheets";
import { getHarleyMeter } from "@/lib/harley-meter";
import { lookupRule } from "@/lib/harley-rules";
import { getHarleyTaskWindow, isCalendarConfigured } from "@/lib/calendar";
import { getDashboardWeakness } from "@/lib/weakness";
import { getLatestCoachPhotoUrl, COACH_PHOTO_FALLBACK } from "@/lib/coach-photo";
import { WeaknessAltarTile } from "@/components/tiles/WeaknessAltarTile";
import { HarleyCalendarTile } from "@/components/tiles/HarleyCalendarTile";
import { GoddessFeetPanel } from "@/components/GoddessFeetPanel";
import { SyncButton } from "@/components/SyncButton";
import {
  dedupeAppsPreferMac,
  displayAppName,
  dropCategoryRows,
  dropMacNonBundleIdLabels,
  fmtPhoneMinutes,
} from "@/lib/screentime-display";
import Link from "next/link";

// Revalidate the page every 30s in production.
export const revalidate = 30;

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
const DRIVE_FOLDER_URL = DRIVE_FOLDER_ID
  ? `https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`
  : "#";
const DRIVE_EMBED_URL = DRIVE_FOLDER_ID
  ? `https://drive.google.com/embeddedfolderview?id=${DRIVE_FOLDER_ID}#grid`
  : "";
const SHEET_URL = process.env.SHEET_ID
  ? `https://docs.google.com/spreadsheets/d/${process.env.SHEET_ID}/edit`
  : "#";

// ---------- Helpers (server) ----------

function isoWeekNumber(d = new Date()): number {
  // ISO 8601 week number
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // 0=Mon
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const diff = date.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 86400 * 1000));
}

function daysUntilSunday(now = new Date()): { label: string; days: number } {
  const day = now.getUTCDay();
  if (day === 0) return { label: "REVIEW DAY", days: 0 };
  const days = 7 - day;
  return { label: `Sun review in ${days} day${days === 1 ? "" : "s"}`, days };
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---------- Screen time summary ----------
//
// Three fixed buckets with daily targets. Today's minutes per bucket
// drive the SCREENTIME tile's tick/X. Match is on the resolved display
// name. Sources for iPhone-side apps (Instagram, dating, etc.) come
// from the mac_ui_iphone scraper (scripts/screentime-ui-sync.ts), which
// reads the Settings → Screen Time pane and posts friendly names like
// "Raya" or "Instagram" verbatim — no bundle-id resolution needed.
// Mac apps from knowledgeC.db post bundle ids and resolve to friendly
// names via APP_DISPLAY_NAMES.

type ScreentimeBucket = {
  label: string;
  apps: Set<string>;
  targetMinutes: number;
};

const SCREENTIME_BUCKETS: ScreentimeBucket[] = [
  { label: "YouTube", apps: new Set(["YouTube"]), targetMinutes: 45 },
  { label: "Instagram", apps: new Set(["Instagram"]), targetMinutes: 10 },
  {
    label: "Dating",
    apps: new Set(["Raya", "Tinder", "Hinge", "Bumble"]),
    targetMinutes: 0,
  },
];

type ScreentimeBucketResult = {
  label: string;
  minutes: number;
  targetMinutes: number;
  obeyed: boolean;
};

type PhoneTileSummary = {
  todayDate: string;
  todayTotal: number;
  sevenDayTotal: number;
  buckets: ScreentimeBucketResult[];
};

function summarizeScreentime(rows: ScreenTimeRow[]): PhoneTileSummary {
  const todayDate = todayInSydney();
  // Drop iOS-Shortcut category-level rows (sent alongside per-app rows
  // for the same period — summing both double-counts), then for each
  // (date, app) prefer mac_launchd over ios_shortcut to collapse the
  // cross-source duplicate that "Share Across Devices" produces.
  const cleaned = dedupeAppsPreferMac(
    dropCategoryRows(dropMacNonBundleIdLabels(rows))
  );
  const today = cleaned.filter((r) => r.date === todayDate);
  const todayTotal = today.reduce((s, r) => s + r.minutes, 0);
  const sevenDayTotal = cleaned.reduce((s, r) => s + r.minutes, 0);
  const buckets: ScreentimeBucketResult[] = SCREENTIME_BUCKETS.map((b) => {
    const minutes = today
      .filter((r) => b.apps.has(displayAppName(r.label)))
      .reduce((s, r) => s + r.minutes, 0);
    return {
      label: b.label,
      minutes,
      targetMinutes: b.targetMinutes,
      obeyed: minutes <= b.targetMinutes,
    };
  });
  return { todayDate, todayTotal, sevenDayTotal, buckets };
}

function todayInSydney(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

// Monday of the current week (Sydney wall-clock), as YYYY-MM-DD.
// Mon=0..Sun=6, so subtract that offset from today's Sydney date.
function mondayOfThisWeekSydney(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const wdMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const offset = wdMap[wd] ?? 0;
  const d = new Date(`${year}-${month}-${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

// ---------- Writing summary ----------
//
// "Writing" = Obsidian foreground time (md.obsidian, same bundle id on
// Mac and iOS). Window is Mon–Sun in Australia/Sydney so the tile
// resets every Monday. Reuses the same row-cleaning pipeline as PHONE
// so cross-device Share-Across-Devices doesn't double-count.

const WRITING_BUNDLE_IDS = new Set<string>(["md.obsidian"]);

type WritingSummary = {
  todayMinutes: number;
  daysWritten: number;
  weekMinutes: number;
};

function summarizeWriting(rows: ScreenTimeRow[]): WritingSummary {
  const todayDate = todayInSydney();
  const weekStart = mondayOfThisWeekSydney();
  const cleaned = dedupeAppsPreferMac(
    dropCategoryRows(dropMacNonBundleIdLabels(rows))
  ).filter(
    (r) => WRITING_BUNDLE_IDS.has(r.label) && r.date >= weekStart
  );
  let todayMinutes = 0;
  let weekMinutes = 0;
  const days = new Set<string>();
  for (const r of cleaned) {
    weekMinutes += r.minutes;
    if (r.minutes > 0) days.add(r.date);
    if (r.date === todayDate) todayMinutes += r.minutes;
  }
  return { todayMinutes, daysWritten: days.size, weekMinutes };
}

// ---------- Page ----------

type DashboardSearchParams = Promise<{ whoop?: string; whoop_error?: string }>;

export default async function Dashboard({
  searchParams,
}: {
  searchParams?: DashboardSearchParams;
}) {
  const configured = isConfigured();
  const params = searchParams ? await searchParams : {};

  // Fetch in parallel; each function is internally cached.
  const [
    harleyBalance,
    whoop,
    harley,
    whoopConnected,
    sysHealth,
    sleepEdits,
    appleHealth,
    whoopWorkouts,
    screentime,
    weakness,
    transactions,
    nutrition,
    coachPhotoUrl,
    worshipTotals,
    drinking,
    videoStore,
  ] = await Promise.all([
    configured ? getHarleyBalance() : Promise.resolve(null as HarleyBalance | null),
    configured ? getLatestWhoopDaily() : Promise.resolve(null),
    configured ? getHarleyMeter() : Promise.resolve(0),
    configured ? isWhoopConnected() : Promise.resolve(false),
    configured ? getDashboardSystemHealth() : Promise.resolve(null),
    configured ? getRecentSleepEdits(5) : Promise.resolve([] as SleepEdit[]),
    configured
      ? getDashboardAppleHealth()
      : Promise.resolve(null as DashboardAppleHealth | null),
    configured
      ? getDashboardWhoopWorkouts()
      : Promise.resolve(null as DashboardWhoopWorkouts | null),
    configured
      ? getDashboardScreentime()
      : Promise.resolve([] as ScreenTimeRow[]),
    configured ? getDashboardWeakness() : Promise.resolve(null),
    configured
      ? getDashboardTransactions()
      : Promise.resolve(null as DashboardTransactions | null),
    configured
      ? getDashboardNutrition()
      : Promise.resolve(null as DashboardNutrition | null),
    getLatestCoachPhotoUrl(),
    configured
      ? getWorshipTotals()
      : Promise.resolve(null as WorshipTotals | null),
    configured
      ? getDrinkingStats()
      : Promise.resolve(null as DrinkingStats | null),
    configured
      ? getVideoStoreSpendMonth()
      : Promise.resolve(null as VideoStoreSpend | null),
  ]);

  const calendarConfigured = isCalendarConfigured();
  const calendarWindow = calendarConfigured
    ? await getHarleyTaskWindow().catch(() => ({ past: [], future: [] }))
    : { past: [], future: [] };

  const phoneSummary = summarizeScreentime(screentime);
  const writingSummary = summarizeWriting(screentime);
  const owedHarley = harleyBalance?.owed ?? 0;
  const week = isoWeekNumber();
  const review = daysUntilSunday();
  const lastUpdated = fmtTime(new Date());

  // Background swap based on Settings.orgasm_allowed. Falls back to coach.jpg
  // when the Sheet isn't configured yet so first-time setup still has a visual.
  const allowed = weakness?.orgasmAllowed === "yes";
  const backgroundSrc = !configured
    ? "/coach.jpg"
    : allowed
    ? "/backgrounds/allowed.jpg"
    : "/backgrounds/denied.jpg";
  const backgroundImage = `url('${backgroundSrc}')`;
  // Brand overlays — rose-bloom when allowed, deep cobalt when denied,
  // warm bloom on first-run setup. Lower opacity than before so Harley
  // shows through; vignette below restores tile contrast.
  const overlayClass = !configured
    ? "bg-bloom-900/30"
    : allowed
    ? "bg-bloom-800/30"
    : "bg-coach-900/45";

  return (
    <div
      className="min-h-screen text-ivory-50 relative bg-iron-vignette bg-fixed bg-center bg-cover"
      style={{ backgroundImage }}
    >
      <div className={`absolute inset-0 ${overlayClass} pointer-events-none`} />
      {/* Radial vignette: clearer in the center (where Harley's face sits),
          darker at the edges so tile text stays legible. Cobalt-tinted
          shadow instead of pure black for a wrought-iron feel. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 0%, transparent 35%, rgba(13,33,72,0.6) 100%)",
        }}
      />

      <div className="relative z-10">
        {/* Setup banner if env not configured */}
        {!configured && (
          <div className="w-full bg-ivory-400/15 backdrop-blur-sm border-b border-ivory-400/40 px-4 py-2 text-xs text-ivory-100">
            <span className="font-bold tracking-wide">SETUP NEEDED:</span> set
            {" "}<code className="bg-ink-deep/60 px-1">GOOGLE_SERVICE_ACCOUNT_JSON</code>,
            {" "}<code className="bg-ink-deep/60 px-1">SHEET_ID</code>, and
            {" "}<code className="bg-ink-deep/60 px-1">DRIVE_FOLDER_ID</code> in Vercel env, then
            redeploy. Showing placeholder data until then.
          </div>
        )}

        {/* Whoop OAuth flash messages */}
        {params.whoop === "connected" && (
          <div className="w-full bg-sage-900/80 backdrop-blur-sm border-b border-sage-700 px-4 py-2 text-xs text-sage-50">
            <span className="font-bold">CONNECTED TO WHOOP ✓</span> &middot; First sync runs at the next cron tick (08:00 AEST) — or hit the sync endpoint manually.
          </div>
        )}
        {params.whoop_error && (
          <div className="w-full bg-bloom-900/80 backdrop-blur-sm border-b border-bloom-700 px-4 py-2 text-xs text-bloom-50">
            <span className="font-bold">WHOOP ERROR:</span> {params.whoop_error}
          </div>
        )}

        {/* Top strip */}
        <div className="w-full bg-ink-deep/80 backdrop-blur-sm border-b border-iron-100/70 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              {/* Wordmark — country-club coach badge */}
              <div className="flex items-center gap-2 pr-3 border-r border-iron-100/60">
                <span className="brand-serif text-xl font-semibold text-ivory tracking-tight leading-none">
                  Harley
                </span>
                <span className="brand-serif italic text-[11px] text-bloom-300 leading-none">
                  &amp; Iron
                </span>
              </div>
              <p className="text-[11px] font-semibold tracking-[0.22em] text-ivory-300/80 uppercase">
                Week {week} <span className="text-iron-50">·</span> {review.label}{" "}
                <span className="text-iron-50">·</span>{" "}
                <span className="text-bloom-300">
                  Owed: ${configured ? owedHarley : 135}
                </span>{" "}
                <span className="text-iron-50">·</span>{" "}
                <VideoStorePill data={videoStore} configured={configured} />
              </p>
              <Link
                href="/harley"
                className="px-2 py-1 border border-bloom-700 bg-bloom-900/40 text-bloom-200 text-[10px] font-bold uppercase tracking-[0.22em] hover:border-bloom-300 hover:bg-bloom-800/60 hover:text-ivory transition-colors whitespace-nowrap shrink-0"
              >
                Goddess control room →
              </Link>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <SystemHealthPill health={sysHealth} configured={configured} />
              <SyncButton />
              <p className="text-[10px] text-ivory-400/70 uppercase tracking-widest">
                Updated {lastUpdated}
              </p>
            </div>
          </div>
        </div>

        {/* Dashboard grid */}
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {weakness && (
            <WeaknessAltarTile
              data={weakness}
              coachPhotoUrl={coachPhotoUrl ?? COACH_PHOTO_FALLBACK}
            />
          )}

          {/* Row 1 */}
          <Tile title="Whoop">
            {whoop && whoop.recovery ? (
              <>
                <Stat
                  label="Recovery"
                  value={`${whoop.recovery}%`}
                  color={recoveryColor(Number(whoop.recovery))}
                />
                <Stat label="Strain" value={whoop.strain || "—"} />
                <Stat label="Sleep" value={fmtSleep(whoop.sleep)} />
              </>
            ) : !configured ? (
              <>
                <Stat label="Recovery" value="72%" color="text-ivory-300" />
                <Stat label="Strain" value="14" />
                <Stat label="Sleep" value="7h 12m" />
              </>
            ) : !whoopConnected ? (
              <ConnectWhoopCta />
            ) : (
              <NoData />
            )}
          </Tile>

          <Tile title="Routine">
            {whoop && (whoop.wakeTime || whoop.bedTime) ? (
              <>
                <StatRow
                  label="Wake"
                  value={whoop.wakeTime || "—"}
                  badge={wakeBadge(whoop.wakeTime)}
                  badgeColor={wakeBadge(whoop.wakeTime) === "✅" ? "text-sage-300" : "text-ivory-300"}
                  badgeTooltip={wakeTooltip(whoop.wakeTime)}
                />
                <StatRow label="Bed" value={whoop.bedTime || "—"} />
                <StatRow
                  label="Steps"
                  value={formatStepsRoutine(appleHealth)}
                />
              </>
            ) : !configured ? (
              <>
                <StatRow label="Wake" value="06:08" badge="-$10" badgeColor="text-bloom-300" />
                <StatRow label="Bed" value="22:45" badge="-$15" badgeColor="text-bloom-300" />
                <StatRow label="Steps" value="8,420" badge="-$15" badgeColor="text-bloom-300" />
              </>
            ) : !whoopConnected ? (
              <ConnectWhoopCta />
            ) : (
              <NoData />
            )}
          </Tile>

          <Tile title="Writing">
            <WritingTile configured={configured} summary={writingSummary} />
          </Tile>

          {/* Row 2 */}
          <Tile title="Workouts this week">
            <GymTileBody
              workouts={whoopWorkouts}
              whoopConnected={whoopConnected}
              configured={configured}
            />
          </Tile>

          <Tile title="Nutrition">
            <NutritionTile data={nutrition} configured={configured} />
          </Tile>

          <Link
            href="/screentime"
            className="block border border-iron-100/70 bg-iron-700/80 backdrop-blur-sm p-4 hover:border-coach-600/70 transition-colors"
          >
            <p className="brand-serif text-[11px] font-semibold tracking-[0.22em] text-ivory-300/80 uppercase mb-3 flex items-center justify-between">
              Screentime
              <span className="text-coach-300 normal-case tracking-normal text-[10px] font-sans">details →</span>
            </p>
            <PhoneTile configured={configured} summary={phoneSummary} />
          </Link>

          {/* Row 3 */}
          <Link
            href="/transactions"
            className="block border border-iron-100/70 bg-iron-700/80 backdrop-blur-sm p-4 hover:border-coach-600/70 transition-colors"
          >
            <p className="brand-serif text-[11px] font-semibold tracking-[0.22em] text-ivory-300/80 uppercase mb-3 flex items-center justify-between">
              Transactions
              <span className="text-coach-300 normal-case tracking-normal text-[10px] font-sans">details →</span>
            </p>
            <TransactionsTile configured={configured} data={transactions} />
          </Link>

          <Tile title="Owed Harley">
            {configured && harleyBalance ? (
              <HarleyBalanceTile balance={harleyBalance} />
            ) : configured ? (
              <NoData />
            ) : (
              <>
                <p className="text-3xl font-bold text-bloom-300 mb-2">$135</p>
                <p className="text-[10px] text-ivory-400/70 uppercase tracking-widest mb-2">
                  $1,135 fines − $1,000 paid
                </p>
                <div className="space-y-1 text-xs text-ivory-100/70">
                  <div className="flex justify-between">
                    <span>Monthly fee — May 2026</span>
                    <span className="text-bloom-300">+$1,000</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Wed phone</span>
                    <span className="text-bloom-300">+$45</span>
                  </div>
                  <div className="flex justify-between">
                    <span>USDT payment</span>
                    <span className="text-sage-300">−$1,000</span>
                  </div>
                </div>
              </>
            )}
          </Tile>

          <Tile title="Harley Meter">
            {(() => {
              const value = configured ? harley : 78;
              return (
                <>
                  <p className="brand-serif text-5xl font-semibold text-ivory mb-2 tracking-tight">{value}%</p>
                  <div className="w-full bg-iron-200 h-2 mb-2">
                    <div
                      className="bg-sage h-2 transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                    />
                  </div>
                  <p className="text-xs text-ivory-400/70 uppercase tracking-wider">
                    {configured ? "wake / bed / gym / steps / water / tasks" : "14 of 18 tasks this week"}
                  </p>
                </>
              );
            })()}
          </Tile>

          <Tile title="Worship totals">
            <WorshipTotalsTile configured={configured} totals={worshipTotals} />
          </Tile>

          <Tile title="DRANK ALCOHOL">
            <DrinkingTile data={drinking} configured={configured} />
          </Tile>
        </div>

        {/* Harley calendar — events Harley adds to the shared `weekly` calendar */}
        <div className="px-4 pb-4">
          <HarleyCalendarTile
            past={calendarWindow.past}
            future={calendarWindow.future}
            configured={calendarConfigured}
          />
        </div>

        {/* Tamper log — proves Whoop sleep stats are untouched (or shows the diff if not) */}
        <div className="px-4 pb-4">
          <TamperLog edits={sleepEdits} configured={configured} />
        </div>

        {/* Peek at Goddess' feet — curtain that splits open to reveal the page background photo */}
        <div className="px-4 pb-4">
          <GoddessFeetPanel imageSrc={backgroundSrc} />
        </div>

        {/* Proof Drops embed */}
        <div className="px-4 pb-4">
          <div className="border border-iron-100/70 bg-iron-700/80 backdrop-blur-sm p-4">
            <p className="brand-serif text-[11px] font-semibold tracking-[0.22em] text-ivory-300/80 uppercase mb-3">
              Proof Drops
            </p>
            {DRIVE_EMBED_URL ? (
              <iframe
                src={DRIVE_EMBED_URL}
                className="w-full"
                style={{ height: 300, border: 0 }}
                title="Proof folder"
              />
            ) : (
              <p className="text-xs text-ivory-400/70">
                Set <code>DRIVE_FOLDER_ID</code> to embed the folder.
              </p>
            )}
            <p className="text-[10px] text-ivory-400/50 mt-2">
              Embed blank? The Drive folder must be set to{" "}
              <em>&ldquo;Anyone with the link can view&rdquo;</em>.
            </p>
          </div>
        </div>

        {/* Bottom strip */}
        <div className="px-4 pb-6 flex flex-wrap gap-2">
          <BottomLink label="Rules" href="/rules" />
          <BottomLink label="Goddess panel" href="/harley" />
          <BottomLink label="Proof folder" href={DRIVE_FOLDER_URL} />
          <BottomLink label="Photos" href="#" />
          <BottomLink label="Coach notes" href="#" />
          <BottomLink label="Budget sheet" href={SHEET_URL} />
        </div>
      </div>
    </div>
  );
}

// ---------- Helpers (UI) ----------

function recoveryColor(score: number): string {
  if (!Number.isFinite(score)) return "text-ivory-100";
  if (score < 34) return "text-bloom-300";
  if (score <= 66) return "text-ivory-300";
  return "text-sage-300";
}

function wakeBadge(wake: string): string | undefined {
  // wake stored as HH:mm 24h. Rule: <06:30 = ✅, otherwise ⚠
  if (!wake) return undefined;
  const m = wake.match(/^(\d{2}):(\d{2})$/);
  if (!m) return undefined;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 6 * 60 + 30 ? "✅" : "⚠";
}

function wakeTooltip(wake: string): string | undefined {
  if (!wake) return undefined;
  const m = wake.match(/^(\d{2}):(\d{2})$/);
  if (!m) return undefined;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes < 6 * 60 + 30) {
    return `Up by 06:30 — wake rule met. Counts as a ✅ toward this week's Harley Meter (1/6 of the score).`;
  }
  const lateMin = minutes - (6 * 60 + 30);
  return `Woke at ${wake} — ${lateMin} min past the 06:30 target. Today fails the wake rule, dropping the Harley Meter (1/6 weight, scored over the rolling 7-day window). See /rules for the full scoring breakdown.`;
}

function fmtSleep(sleep: string): string {
  if (!sleep) return "—";
  const n = Number(sleep);
  if (!Number.isFinite(n)) return sleep;
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// ---------- Components ----------

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-iron-100/70 bg-iron-700/80 backdrop-blur-sm p-4 shadow-[0_1px_0_rgba(243,231,204,0.04)_inset]">
      <p className="brand-serif text-[11px] font-semibold tracking-[0.22em] text-ivory-300/80 uppercase mb-3">
        {title}
      </p>
      {children}
    </div>
  );
}

function ConnectWhoopCta() {
  return (
    <a
      href="/api/whoop/connect"
      className="inline-block mt-1 px-3 py-2 border border-coach-600 bg-coach-900/40 text-coach-200 text-xs uppercase tracking-widest hover:border-coach-300 hover:bg-coach-800/60 transition-colors"
    >
      Connect Whoop →
    </a>
  );
}

function HarleyBalanceTile({ balance }: { balance: HarleyBalance }) {
  const owed = balance.owed;
  const owedColor = owed > 0 ? "text-bloom-300" : owed < 0 ? "text-sage-300" : "text-ivory";
  const owedLabel = owed < 0 ? `Overpaid $${Math.abs(owed).toLocaleString("en-AU")}` : `$${owed.toLocaleString("en-AU")}`;
  return (
    <>
      <p className={`text-3xl font-bold mb-2 ${owedColor}`}>{owedLabel}</p>
      <p className="text-[10px] text-ivory-400/70 uppercase tracking-widest mb-2">
        ${balance.finesTotal.toLocaleString("en-AU")} fines − $
        {balance.paidTotal.toLocaleString("en-AU")} paid
      </p>
      {balance.recentActivity.length > 0 ? (
        <div className="space-y-1 text-xs text-ivory-100/70">
          {balance.recentActivity.map((a, i) => (
            <HarleyActivityRow key={i} activity={a} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-ivory-400/60 italic">no activity yet</p>
      )}
    </>
  );
}

type HarleyActivity = HarleyBalance["recentActivity"][number];

function HarleyActivityRow({ activity }: { activity: HarleyActivity }) {
  const isFine = activity.kind === "fine";
  const label = isFine
    ? activity.reason || "Fine"
    : `${activity.currency || "USDT"} payment`;
  const tooltip = buildActivityTooltip(activity);
  const amountClass = isFine ? "text-bloom-300" : "text-sage-300";
  const sign = isFine ? "+" : "−";
  return (
    <div className="relative group flex justify-between gap-2 cursor-help" tabIndex={0}>
      <span className="truncate">{label}</span>
      <span className={`shrink-0 ${amountClass}`}>
        {sign}${activity.amount.toLocaleString("en-AU")}
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full mt-2 z-20 w-64 border border-iron-100 bg-ink-deep p-3 text-[11px] leading-relaxed text-ivory-100/80 shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity whitespace-pre-line text-left normal-case"
      >
        {tooltip}
      </span>
    </div>
  );
}

function buildActivityTooltip(a: HarleyActivity): string {
  if (a.kind === "payment") {
    return `${a.currency || "USDT"} payment\nDate: ${a.date}`;
  }
  const lines: string[] = [];
  const rule = lookupRule(a.ruleId);
  if (rule) {
    lines.push(`Auto-fine: ${rule.label}`);
    lines.push(`Source: ${rule.source}`);
  } else {
    lines.push("Manual fine");
  }
  if (a.setBy) lines.push(`Set by: ${a.setBy}`);
  lines.push(`Date: ${a.date}`);
  return lines.join("\n");
}

function NoData() {
  return <p className="text-xs text-ivory-400/60 italic">no data yet</p>;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fmtWorshipDuration(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "0m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function DrinkingTile({
  configured,
  data,
}: {
  configured: boolean;
  data: DrinkingStats | null;
}) {
  if (!configured) {
    return (
      <>
        <p className="text-3xl font-bold text-emerald-300 mb-2">12d</p>
        <p className="text-[10px] text-zinc-500 uppercase tracking-widest mb-2">
          Sober streak
        </p>
        <p className="text-xs text-zinc-400">0 this week · 1 lifetime</p>
      </>
    );
  }
  if (!data) return <NoData />;
  const { thisWeekCount, daysSinceLastDrink, totalCount, lastDrinkDate } = data;
  const streakDisplay =
    daysSinceLastDrink === null ? "∞" : `${daysSinceLastDrink}d`;
  const headlineColor =
    daysSinceLastDrink === null || daysSinceLastDrink >= 7
      ? "text-emerald-300"
      : daysSinceLastDrink >= 3
      ? "text-amber-300"
      : "text-rose-300";
  return (
    <>
      <p className={`text-3xl font-bold ${headlineColor} mb-2`}>{streakDisplay}</p>
      <p className="text-[10px] text-zinc-500 uppercase tracking-widest mb-2">
        Sober streak
      </p>
      <div className="space-y-0.5 text-xs text-zinc-400">
        <div className="flex justify-between">
          <span>This week</span>
          <span
            className={`font-mono ${
              thisWeekCount > 0 ? "text-rose-300" : "text-zinc-200"
            }`}
          >
            {thisWeekCount}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Lifetime</span>
          <span className="text-zinc-200 font-mono">{totalCount}</span>
        </div>
        {lastDrinkDate && (
          <p className="text-[10px] text-zinc-500 italic pt-1">
            Last: {lastDrinkDate.slice(5)}
          </p>
        )}
      </div>
    </>
  );
}

function WorshipTotalsTile({
  configured,
  totals,
}: {
  configured: boolean;
  totals: WorshipTotals | null;
}) {
  if (!configured) {
    return (
      <>
        <p className="brand-serif text-3xl font-semibold text-bloom-300 mb-2">$2,800</p>
        <p className="text-xs text-ivory-400/70 uppercase tracking-wider mb-1">
          Lifetime given
        </p>
        <p className="text-xs text-ivory-100/70">0 edges · 0m worship</p>
      </>
    );
  }
  if (!totals) return <NoData />;
  return (
    <>
      <p className="brand-serif text-3xl font-semibold text-bloom-300 mb-2">
        {fmtMoney(totals.moneyGivenUsd)}
      </p>
      <p className="text-[10px] text-ivory-400/70 uppercase tracking-widest mb-2">
        Lifetime given
      </p>
      <div className="space-y-0.5 text-xs text-ivory-100/70">
        <div className="flex justify-between">
          <span>Total edges</span>
          <span className="text-ivory-50 font-mono">{totals.totalEdges}</span>
        </div>
        <div className="flex justify-between">
          <span>Worship time</span>
          <span className="text-ivory-50 font-mono">
            {fmtWorshipDuration(totals.worshipMinutes)}
          </span>
        </div>
      </div>
    </>
  );
}


function formatStepsRoutine(ah: DashboardAppleHealth | null): string {
  if (!ah || (!ah.todaySteps && !ah.weekStepsAvg)) return "—";
  const today = ah.todaySteps ? ah.todaySteps.toLocaleString("en-AU") : "0";
  if (!ah.weekStepsAvg) return `${today} today`;
  const avg = ah.weekStepsAvg.toLocaleString("en-AU");
  return `${today} today · ${avg} avg`;
}

function formatWorkoutDuration(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function GymTileBody({
  workouts,
  whoopConnected,
  configured,
}: {
  workouts: DashboardWhoopWorkouts | null;
  whoopConnected: boolean;
  configured: boolean;
}) {
  if (!configured) {
    return (
      <>
        <p className="brand-serif text-5xl font-semibold text-ivory mb-2 tracking-tight">4 / 7</p>
        <p className="text-xs text-ivory-400/70">Latest: Run · 32m · strain 14.2</p>
      </>
    );
  }
  if (!whoopConnected) {
    return <ConnectWhoopCta />;
  }
  const count = workouts?.weekWorkoutCount ?? 0;
  const latest = workouts?.latestWorkout;
  const countColor =
    count >= 5 ? "text-sage-300" : count >= 3 ? "text-ivory-300" : "text-ivory-100/70";
  return (
    <>
      <p className={`brand-serif text-5xl font-semibold mb-2 tracking-tight ${countColor}`}>{count} / 7</p>
      {latest ? (
        <p className="text-xs text-ivory-400/70">
          Latest: {latest.sportName} ·{" "}
          {formatWorkoutDuration(latest.durationMin)}
          {typeof latest.strain === "number" && ` · strain ${latest.strain.toFixed(1)}`}
        </p>
      ) : (
        <p className="text-xs text-ivory-400/70">no workouts logged this week</p>
      )}
    </>
  );
}


function NutritionTile({
  data,
  configured,
}: {
  data: DashboardNutrition | null;
  configured: boolean;
}) {
  if (!configured) {
    return (
      <>
        <NutritionRow label="Protein" value="148" target="221" unit="g" />
        <NutritionRow label="Calories" value="2210" target="2940" unit="kcal" />
        <NutritionRow label="Water" value="2.4" target="3.35" unit="L" />
      </>
    );
  }
  if (!data) {
    return <NoData />;
  }
  return (
    <>
      <NutritionRow
        label="Protein"
        value={String(data.proteinG)}
        target={String(data.proteinTarget)}
        unit="g"
        pct={data.proteinG / data.proteinTarget}
      />
      <NutritionRow
        label="Calories"
        value={String(data.caloriesConsumed)}
        target={String(data.calorieTarget)}
        unit="kcal"
        pct={data.caloriesConsumed / data.calorieTarget}
      />
      <NutritionRow
        label="Water"
        value={(data.waterMl / 1000).toFixed(2)}
        target={(data.waterTargetMl / 1000).toFixed(2)}
        unit="L"
        pct={data.waterMl / data.waterTargetMl}
      />
      {!data.hasToday && (
        <p className="text-[10px] text-ivory-300/80 mt-2 italic">
          showing {data.date} — no data for today yet
        </p>
      )}
    </>
  );
}

function NutritionRow({
  label,
  value,
  target,
  unit,
  pct,
}: {
  label: string;
  value: string;
  target: string;
  unit: string;
  pct?: number;
}) {
  const ratio = Math.max(0, Math.min(1, pct ?? 0));
  const barColor =
    ratio >= 0.95
      ? "bg-sage"
      : ratio >= 0.6
      ? "bg-ivory-300"
      : "bg-iron-50";
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-ivory-300/80 uppercase tracking-wider text-[10px]">
          {label}
        </span>
        <span className="font-mono text-ivory-50">
          {value}
          <span className="text-ivory-400/60"> / {target} {unit}</span>
        </span>
      </div>
      <div className="w-full bg-iron-200 h-1 mt-1">
        <div
          className={`${barColor} h-1 transition-all`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

function fmtAmount(n: number, currency = "AUD"): string {
  if (!Number.isFinite(n)) return "—";
  const symbol = currency === "USD" ? "US$" : "$";
  return `${symbol}${n.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function TransactionsTile({
  configured,
  data,
}: {
  configured: boolean;
  data: DashboardTransactions | null;
}) {
  if (!configured) {
    return (
      <>
        <Stat label="Today" value="$52.10" />
        <Stat label="7d" value="$437.20" />
        <p className="text-xs text-ivory-400/70 mt-2">Balance $2,180.55</p>
      </>
    );
  }
  if (!data || !data.hasAnyData) {
    return (
      <>
        <p className="text-sm text-ivory-400/70">No Amex data yet</p>
        <p className="text-[10px] text-ivory-400/50 uppercase tracking-widest mt-1">
          Awaiting inbound emails
        </p>
      </>
    );
  }
  const recent = data.charges.slice(0, 3);
  return (
    <>
      <div className="mb-2 flex items-baseline gap-3">
        <span>
          <span className="text-[10px] text-ivory-400/70 uppercase tracking-wider">
            Today{" "}
          </span>
          <span className="text-xl font-bold text-ivory">
            {fmtAmount(data.todayChargeTotal)}
          </span>
        </span>
        <span>
          <span className="text-[10px] text-ivory-400/70 uppercase tracking-wider">
            7d{" "}
          </span>
          <span className="text-sm font-semibold text-ivory-100/80">
            {fmtAmount(data.sevenDayChargeTotal)}
          </span>
        </span>
      </div>
      {recent.length > 0 ? (
        <div className="space-y-0.5 mb-2">
          {recent.map((c) => (
            <div
              key={c.emailId}
              className="flex items-center justify-between gap-2 text-xs text-ivory-100/80"
            >
              <span className="truncate">{c.merchant || "(unknown)"}</span>
              <span className="font-mono shrink-0">
                {fmtAmount(c.amount, c.currency)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {data.latestBalance ? (
        <p className="text-[10px] text-ivory-400/70 uppercase tracking-widest">
          Balance{" "}
          <span className="text-ivory-100/80 normal-case tracking-normal">
            {fmtAmount(data.latestBalance.amount, data.latestBalance.currency)}
          </span>
        </p>
      ) : null}
    </>
  );
}

function WritingTile({
  configured,
  summary,
}: {
  configured: boolean;
  summary: WritingSummary;
}) {
  if (!configured) {
    return (
      <>
        <p className="brand-serif text-5xl font-semibold text-ivory-300 mb-2 tracking-tight">23m</p>
        <p className="text-xs text-ivory-400/70">4 / 7 days · 2h 14m this week</p>
      </>
    );
  }
  const today = summary.todayMinutes;
  const todayColor =
    today >= 30 ? "text-sage-300" : today >= 5 ? "text-ivory-300" : "text-ivory-100/70";
  return (
    <>
      <p className={`brand-serif text-5xl font-semibold mb-2 tracking-tight ${todayColor}`}>
        {fmtPhoneMinutes(today)}
      </p>
      <p className="text-xs text-ivory-400/70">
        {summary.daysWritten} / 7 days · {fmtPhoneMinutes(summary.weekMinutes)} this week
      </p>
    </>
  );
}

function PhoneTile({
  configured,
  summary,
}: {
  configured: boolean;
  summary: PhoneTileSummary;
}) {
  if (!configured) {
    return (
      <>
        <StatRow label="YouTube" value="32m / 45m" badge="✓" badgeColor="text-sage-300" />
        <StatRow label="Instagram" value="8m / 10m" badge="✓" badgeColor="text-sage-300" />
        <StatRow label="Dating" value="0m / 0m" badge="✓" badgeColor="text-sage-300" />
      </>
    );
  }
  return (
    <>
      {summary.buckets.map((b) => (
        <StatRow
          key={b.label}
          label={b.label}
          value={`${fmtPhoneMinutes(b.minutes)} / ${fmtPhoneMinutes(b.targetMinutes)}`}
          badge={b.obeyed ? "✓" : "✗"}
          badgeColor={b.obeyed ? "text-sage-300" : "text-bloom-300"}
        />
      ))}
      <p className="text-xs text-ivory-400/70 mt-2">
        today {fmtPhoneMinutes(summary.todayTotal)}
        {summary.sevenDayTotal > 0
          ? ` · 7d ${fmtPhoneMinutes(summary.sevenDayTotal)}`
          : ""}
      </p>
    </>
  );
}

function Stat({
  label,
  value,
  color = "text-ivory",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="mb-1">
      <span className="text-[10px] text-ivory-400/70 uppercase tracking-wider">
        {label}{" "}
      </span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
    </div>
  );
}

function StatRow({
  label,
  value,
  badge,
  badgeColor = "text-sage-300",
  valueColor = "text-ivory",
  badgeTooltip,
}: {
  label: string;
  value: string;
  badge?: string;
  badgeColor?: string;
  valueColor?: string;
  badgeTooltip?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-ivory-400/70 uppercase tracking-wider">{label}</span>
      <span className="flex items-center gap-2">
        <span className={`text-sm font-semibold ${valueColor}`}>{value}</span>
        {badge &&
          (badgeTooltip ? (
            <span className="relative group cursor-help" tabIndex={0}>
              <span className={`text-sm ${badgeColor}`} aria-describedby="badge-tip">
                {badge}
              </span>
              <span
                role="tooltip"
                id="badge-tip"
                className="pointer-events-none absolute right-0 top-full mt-2 z-20 w-64 border border-iron-100 bg-ink-deep p-3 text-[11px] leading-relaxed text-ivory-100/80 shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
              >
                {badgeTooltip}
              </span>
            </span>
          ) : (
            <span className={`text-sm ${badgeColor}`}>{badge}</span>
          ))}
      </span>
    </div>
  );
}

function BottomLink({ label, href }: { label: string; href: string }) {
  const isExternal = href.startsWith("http");
  return (
    <a
      href={href}
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="px-4 py-2 border border-iron-100 bg-iron-700/40 text-xs text-ivory-300/80 uppercase tracking-[0.22em] hover:border-coach-500 hover:text-ivory hover:bg-coach-900/40 transition-colors"
    >
      {label}
    </a>
  );
}

function VideoStorePill({
  data,
  configured,
}: {
  data: VideoStoreSpend | null;
  configured: boolean;
}) {
  // Visible label + raw retail spend, plus what Daniel owes Harley once
  // monthly spend crosses the $400 discount cap (90% of the excess). The
  // value is taken from the manually-updated Settings row; freshness is
  // inferred from the row's Last Updated month.
  const amount = configured ? data?.amount ?? 0 : 0;
  const cap = data?.cap ?? 400;
  const owed = configured ? data?.owed ?? 0 : 0;
  const overCap = amount > cap;
  const color = overCap || amount >= cap * 0.75 ? "text-bloom-300" : "text-ivory-300/80";
  const fmt = (n: number) => Math.round(n).toLocaleString("en-AU");
  return (
    <span className={color}>
      Video store: ${fmt(amount)} / ${fmt(cap)}
      {overCap && (
        <>
          {" "}<span className="text-bloom-300">(owe ${fmt(owed)})</span>
        </>
      )}
    </span>
  );
}

// ---------- Phase 2C components ----------

function SystemHealthPill({
  health,
  configured,
}: {
  health: SystemHealth | null;
  configured: boolean;
}) {
  if (!configured) {
    return (
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ivory-400/70">
        <span className="w-2 h-2 rounded-full bg-iron-50 inline-block" />
        unconfigured
      </span>
    );
  }
  if (!health) {
    return (
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ivory-400/70">
        <span className="w-2 h-2 rounded-full bg-iron-50 inline-block" />
        no heartbeat yet
      </span>
    );
  }
  const ageMin = ageMinutes(health.timestamp);
  const stale = ageMin === null || ageMin > 15;
  let dotColor = "bg-sage";
  let label = "healthy";
  if (!health.heartbeatOk || stale) {
    dotColor = "bg-bloom";
    label = !health.heartbeatOk ? "broken" : "stale";
  } else if (health.recentSleepEdits > 0) {
    dotColor = "bg-ivory-300";
    label = `${health.recentSleepEdits} edit${health.recentSleepEdits === 1 ? "" : "s"}`;
  }
  return (
    <span
      className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ivory-100/80"
      title={`heartbeat ${ageMin ?? "?"}min ago | whoop ${health.whoopOk ? "ok" : "stale"} | sleep edits 24h: ${health.recentSleepEdits}`}
    >
      <span className={`w-2 h-2 rounded-full ${dotColor} inline-block`} />
      {label} &middot; {ageMin === null ? "?" : `${ageMin}m ago`}
    </span>
  );
}

function ageMinutes(iso: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function TamperLog({
  edits,
  configured,
}: {
  edits: SleepEdit[];
  configured: boolean;
}) {
  // Filter to last 7 days
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = configured
    ? edits.filter((e) => {
        const t = Date.parse(e.detectedAt);
        return !isNaN(t) && t >= sevenDaysAgo;
      })
    : [];
  const tampered = recent.length > 0;

  // Container colour shifts: clean = subtle iron, tampered = bloom-tinted alarm.
  const containerClass = !configured
    ? "border border-iron-100/70 bg-iron-700/80 backdrop-blur-sm p-4"
    : tampered
    ? "border border-bloom-700 bg-bloom-900/30 backdrop-blur-sm p-4"
    : "border border-sage-700/60 bg-iron-700/80 backdrop-blur-sm p-4";

  const titleColor = tampered ? "text-bloom-300" : "text-ivory-300/80";

  return (
    <div className={containerClass}>
      <p
        className={`brand-serif text-[11px] font-semibold tracking-[0.22em] uppercase mb-3 ${titleColor}`}
      >
        Tamper Log
      </p>
      {!configured ? (
        <p className="text-xs text-ivory-400/60 italic">unconfigured</p>
      ) : !tampered ? (
        <p className="text-xs text-sage-300">
          Clean — stats untouched for 7 days ✓
        </p>
      ) : (
        <>
          <p className="text-xs text-bloom-300 font-bold mb-2 uppercase tracking-wider">
            ⚠ {recent.length} edit{recent.length === 1 ? "" : "s"} detected in
            last 7 days
          </p>
          <div className="space-y-1.5">
            {recent.map((e, i) => (
              <div
                key={`${e.detectedAt}-${i}`}
                className="flex flex-wrap items-center gap-2 text-xs text-ivory-100/80"
              >
                <span className="text-bloom-300 shrink-0">⚠</span>
                <span className="text-ivory-400/70 shrink-0 tabular-nums">
                  {fmtDetectedAt(e.detectedAt)}
                </span>
                <span className="text-ivory-100/80 uppercase tracking-wider text-[10px] shrink-0">
                  {e.fieldChanged}
                </span>
                <span className="font-mono">
                  <span className="text-ivory-400/60 line-through">
                    {e.oldValue || "—"}
                  </span>
                  <span className="text-ivory-400/40"> → </span>
                  <span className="text-bloom-200">{e.newValue || "—"}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function fmtDetectedAt(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso || "—";
  const d = new Date(t);
  const date = d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", timeZone: "Australia/Sydney" });
  const time = d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Australia/Sydney",
  });
  return `${date} ${time}`;
}
