export default function Dashboard() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Top strip */}
      <div className="w-full bg-[#060606] border-b border-[#222] px-4 py-3">
        <p className="text-sm font-semibold tracking-widest text-white uppercase">
          WEEK 18 &middot; Sun review in 4 days &middot;{" "}
          <span className="text-red-400">OWED THIS WEEK: $135</span>
        </p>
        <div className="mt-2 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input type="checkbox" className="accent-green-500 w-4 h-4" />
            30 min cardio
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input type="checkbox" className="accent-green-500 w-4 h-4" />
            Hit protein
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input type="checkbox" className="accent-green-500 w-4 h-4" />
            Submit proof
          </label>
        </div>
      </div>

      {/* Dashboard grid */}
      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">

        {/* Row 1 */}
        <Tile title="WHOOP">
          <Stat label="Recovery" value="72%" color="text-amber-400" />
          <Stat label="Strain" value="14" />
          <Stat label="Sleep" value="7h 12m" />
        </Tile>

        <Tile title="ROUTINE">
          <StatRow label="Wake" value="06:08" badge="-$10" badgeColor="text-red-400" />
          <StatRow label="Bed" value="22:45" badge="-$15" badgeColor="text-red-400" />
          <StatRow label="Steps" value="8,420" badge="-$15" badgeColor="text-red-400" />
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
          <p className="text-3xl font-bold text-red-400 mb-2">$135</p>
          <div className="space-y-1 text-xs text-zinc-400">
            <div className="flex justify-between">
              <span>Mon late wake</span><span className="text-red-400">$10</span>
            </div>
            <div className="flex justify-between">
              <span>Wed phone</span><span className="text-red-400">$45</span>
            </div>
            <div className="flex justify-between">
              <span>Sat writing</span><span className="text-red-400">$30</span>
            </div>
          </div>
        </Tile>

        <Tile title="OBEDIENCE SCORE">
          <p className="text-5xl font-bold text-white mb-2">78%</p>
          <div className="w-full bg-[#222] h-2 mb-2">
            <div className="bg-green-500 h-2" style={{ width: "78%" }} />
          </div>
          <p className="text-xs text-zinc-500 uppercase tracking-wider">14 of 18 tasks this week</p>
        </Tile>

      </div>

      {/* Bottom strip */}
      <div className="px-4 pb-6 flex flex-wrap gap-2">
        {["Proof folder", "Photos", "Coach notes", "Budget sheet"].map((label) => (
          <a
            key={label}
            href="#"
            className="px-4 py-2 border border-[#333] text-xs text-zinc-400 uppercase tracking-widest hover:border-zinc-500 hover:text-white transition-colors"
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-[#222] bg-[#0f0f0f] p-4">
      <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-3">{title}</p>
      {children}
    </div>
  );
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
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label} </span>
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
