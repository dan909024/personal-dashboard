import {
  getOpenTasks,
  getPunishments,
  getLatestWhoopDaily,
  getHarleyMeter,
  isConfigured,
  isWhoopConnected,
} from "@/lib/sheets";

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

// ---------- Page ----------

type DashboardSearchParams = Promise<{ whoop?: string; whoop_error?: string }>;

export default async function Dashboard({
  searchParams,
}: {
  searchParams?: DashboardSearchParams;
}) {
  const configured = isConfigured();
  const params = searchParams ? await searchParams : {};

  // Fetch in parallel; each function is internally cached (30s).
  const [openTasks, punishments, whoop, harley, whoopConnected] = await Promise.all([
    configured ? getOpenTasks(3) : Promise.resolve([]),
    configured ? getPunishments() : Promise.resolve([]),
    configured ? getLatestWhoopDaily() : Promise.resolve(null),
    configured ? getHarleyMeter() : Promise.resolve(0),
    configured ? isWhoopConnected() : Promise.resolve(false),
  ]);

  const owedThisWeek = punishments.reduce((sum, p) => sum + (p.paid ? 0 : p.amount), 0);
  const week = isoWeekNumber();
  const review = daysUntilSunday();
  const lastUpdated = fmtTime(new Date());

  return (
    <div
      className="min-h-screen text-white relative bg-[#0a0a0a] bg-fixed bg-center bg-cover"
      style={{ backgroundImage: "url('/coach.jpg')" }}
    >
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/55 pointer-events-none" />

      <div className="relative z-10">
        {/* Setup banner if env not configured */}
        {!configured && (
          <div className="w-full bg-amber-900/80 backdrop-blur-sm border-b border-amber-700 px-4 py-2 text-xs text-amber-100">
            <span className="font-bold">SETUP NEEDED:</span> set
            {" "}<code className="bg-black/30 px-1">GOOGLE_SERVICE_ACCOUNT_JSON</code>,
            {" "}<code className="bg-black/30 px-1">SHEET_ID</code>, and
            {" "}<code className="bg-black/30 px-1">DRIVE_FOLDER_ID</code> in Vercel env, then
            redeploy. Showing placeholder data until then.
          </div>
        )}

        {/* Whoop OAuth flash messages */}
        {params.whoop === "connected" && (
          <div className="w-full bg-emerald-900/80 backdrop-blur-sm border-b border-emerald-700 px-4 py-2 text-xs text-emerald-100">
            <span className="font-bold">CONNECTED TO WHOOP ✅</span> &middot; First sync runs at the next cron tick (08:00 AEST) — or hit the sync endpoint manually.
          </div>
        )}
        {params.whoop_error && (
          <div className="w-full bg-red-900/80 backdrop-blur-sm border-b border-red-700 px-4 py-2 text-xs text-red-100">
            <span className="font-bold">WHOOP ERROR:</span> {params.whoop_error}
          </div>
        )}

        {/* Top strip */}
        <div className="w-full bg-black/60 backdrop-blur-sm border-b border-[#222] px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold tracking-widest text-white uppercase">
              WEEK {week} &middot; {review.label} &middot;{" "}
              <span className="text-red-400">
                OWED THIS WEEK: ${configured ? owedThisWeek : 135}
              </span>
            </p>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest shrink-0">
              Updated {lastUpdated}
            </p>
          </div>
          <div className="mt-2 flex flex-wrap gap-4">
            {(configured && openTasks.length > 0
              ? openTasks.map((t) => t.task)
              : ["30 min cardio", "Hit protein", "Submit proof"]
            ).map((label, i) => (
              <label
                key={`${i}-${label}`}
                className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer"
              >
                <input type="checkbox" className="accent-green-500 w-4 h-4" />
                {label}
              </label>
            ))}
          </div>
        </div>

        {/* Dashboard grid */}
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Row 1 */}
          <Tile title="WHOOP">
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
                <Stat label="Recovery" value="72%" color="text-amber-400" />
                <Stat label="Strain" value="14" />
                <Stat label="Sleep" value="7h 12m" />
              </>
            ) : !whoopConnected ? (
              <ConnectWhoopCta />
            ) : (
              <NoData />
            )}
          </Tile>

          <Tile title="ROUTINE">
            {whoop && (whoop.wakeTime || whoop.bedTime) ? (
              <>
                <StatRow
                  label="Wake"
                  value={whoop.wakeTime || "—"}
                  badge={wakeBadge(whoop.wakeTime)}
                  badgeColor={wakeBadge(whoop.wakeTime) === "✅" ? "text-green-400" : "text-amber-400"}
                />
                <StatRow label="Bed" value={whoop.bedTime || "—"} />
                <StatRow label="Steps" value="—" />
              </>
            ) : !configured ? (
              <>
                <StatRow label="Wake" value="06:08" badge="-$10" badgeColor="text-red-400" />
                <StatRow label="Bed" value="22:45" badge="-$15" badgeColor="text-red-400" />
                <StatRow label="Steps" value="8,420" badge="-$15" badgeColor="text-red-400" />
              </>
            ) : !whoopConnected ? (
              <ConnectWhoopCta />
            ) : (
              <NoData />
            )}
          </Tile>

          <Tile title="WRITING">
            <StatRow label="Book" value="4.2h" badge="⚠" badgeColor="text-amber-400" />
            <StatRow label="Craft" value="2.1h" badge="⚠" badgeColor="text-amber-400" />
            <p className="text-xs text-zinc-500 mt-2">(week so far)</p>
          </Tile>

          {/* Row 2 */}
          <Tile title="GYM (LADDER)">
            <StatRow label="Today" value="" badge="✅" />
            <StatRow label="Streak" value="6 days" />
            <StatRow label="Strain" value="14" badge="✅" />
          </Tile>

          <Tile title="NUTRITION">
            <Stat label="Calories" value="1,840" />
            <Stat label="Protein" value="142g" />
            <StatRow label="Water" value="2.8L" badge="⚠" badgeColor="text-amber-400" />
          </Tile>

          <Tile title="PHONE">
            <StatRow label="IG" value="8 min" badge="✅" />
            <StatRow label="YT" value="62 min" badge="⚠" badgeColor="text-amber-400" />
            <StatRow label="Dating" value="clean" badge="✅" />
          </Tile>

          {/* Row 3 */}
          <Tile title="MONEY">
            <StatRow label="Bank 1" value="$4,231" />
            <StatRow label="Bank 2" value="$812" />
            <StatRow label="Amex" value="-$1,245" valueColor="text-red-400" />
          </Tile>

          <Tile title="PUNISHMENTS THIS WEEK">
            {configured && punishments.length > 0 ? (
              <>
                <p className="text-3xl font-bold text-red-400 mb-2">
                  ${owedThisWeek}
                </p>
                <div className="space-y-1 text-xs text-zinc-400">
                  {punishments.slice(0, 3).map((p, i) => (
                    <div key={i} className="flex justify-between">
                      <span className="truncate pr-2">{p.reason || "—"}</span>
                      <span className="text-red-400 shrink-0">${p.amount}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : configured ? (
              <NoData />
            ) : (
              <>
                <p className="text-3xl font-bold text-red-400 mb-2">$135</p>
                <div className="space-y-1 text-xs text-zinc-400">
                  <div className="flex justify-between">
                    <span>Mon late wake</span>
                    <span className="text-red-400">$10</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Wed phone</span>
                    <span className="text-red-400">$45</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Sat writing</span>
                    <span className="text-red-400">$30</span>
                  </div>
                </div>
              </>
            )}
          </Tile>

          <Tile title="HARLEY METER">
            {(() => {
              const value = configured ? harley : 78;
              return (
                <>
                  <p className="text-5xl font-bold text-white mb-2">{value}%</p>
                  <div className="w-full bg-[#222] h-2 mb-2">
                    <div
                      className="bg-green-500 h-2"
                      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider">
                    {configured ? "from Daily Log" : "14 of 18 tasks this week"}
                  </p>
                </>
              );
            })()}
          </Tile>
        </div>

        {/* Proof Drops embed */}
        <div className="px-4 pb-4">
          <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
            <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
              PROOF DROPS
            </p>
            {DRIVE_EMBED_URL ? (
              <iframe
                src={DRIVE_EMBED_URL}
                className="w-full"
                style={{ height: 300, border: 0 }}
                title="Proof folder"
              />
            ) : (
              <p className="text-xs text-zinc-500">
                Set <code>DRIVE_FOLDER_ID</code> to embed the folder.
              </p>
            )}
            <p className="text-[10px] text-zinc-600 mt-2">
              Embed blank? The Drive folder must be set to{" "}
              <em>&ldquo;Anyone with the link can view&rdquo;</em>.
            </p>
          </div>
        </div>

        {/* Bottom strip */}
        <div className="px-4 pb-6 flex flex-wrap gap-2">
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
  if (!Number.isFinite(score)) return "text-zinc-300";
  if (score < 34) return "text-red-400";
  if (score <= 66) return "text-amber-400";
  return "text-green-400";
}

function wakeBadge(wake: string): string | undefined {
  // wake stored as HH:mm 24h. Rule: <06:30 = ✅, otherwise ⚠
  if (!wake) return undefined;
  const m = wake.match(/^(\d{2}):(\d{2})$/);
  if (!m) return undefined;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 6 * 60 + 30 ? "✅" : "⚠";
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
    <div className="border border-[#222] bg-[#0f0f0f]/85 backdrop-blur-sm p-4">
      <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">
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
      className="inline-block mt-1 px-3 py-2 border border-emerald-700 bg-emerald-900/40 text-emerald-200 text-xs uppercase tracking-widest hover:border-emerald-500 hover:bg-emerald-800/60 transition-colors"
    >
      Connect Whoop →
    </a>
  );
}

function NoData() {
  return <p className="text-xs text-zinc-500 italic">no data yet</p>;
}

function Stat({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="mb-1">
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
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
  badgeColor = "text-green-400",
  valueColor = "text-white",
}: {
  label: string;
  value: string;
  badge?: string;
  badgeColor?: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
      <span className="flex items-center gap-2">
        <span className={`text-sm font-semibold ${valueColor}`}>{value}</span>
        {badge && <span className={`text-sm ${badgeColor}`}>{badge}</span>}
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
      className="px-4 py-2 border border-[#333] text-xs text-zinc-400 uppercase tracking-widest hover:border-zinc-500 hover:text-white transition-colors"
    >
      {label}
    </a>
  );
}
