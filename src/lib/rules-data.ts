/**
 * Builds a WeekInput for the rules evaluator from the Sheet's data
 * tabs. Used by both the weekly cron and the dashboard tile that
 * shows the running current-week estimate, so screen-time cleanup
 * (drop categories, dedupe by source, prefer mac) is consistent.
 */
import {
  getRecentAppleHealth,
  getRecentScreentime,
  getRecentWhoopDaily,
  getWhoopWorkoutsBetween,
} from "./sheets";
import type {
  ScreentimeLite,
  WeekInput,
  WhoopDailyLite,
  WhoopWorkoutLite,
} from "./rules";

const APP_DISPLAY_NAMES: Record<string, string> = {
  "com.burbn.instagram": "Instagram",
  "com.cardify.tinder": "Tinder",
  "co.match.tinder": "Tinder",
  "com.hinge.app": "Hinge",
  "com.bumble.app": "Bumble",
  "com.google.ios.youtube": "YouTube",
  "com.zhiliaoapp.musically": "TikTok",
};
function displayAppName(label: string): string {
  return APP_DISPLAY_NAMES[label] ?? label;
}

export type BuildOptions = {
  /** ISO week id, e.g. "2026-W18". */
  weekId: string;
  /** Mon-Sun days to evaluate. Pass a subset for partial weeks. */
  days: string[];
};

export async function buildWeekInput(opts: BuildOptions): Promise<WeekInput> {
  const monday = opts.days[0];
  const sunday = opts.days[opts.days.length - 1];

  // 14-day window covers Mon-Sun even with timezone slack.
  const [whoopDailies, workouts, healthRows, screentimeRows] = await Promise.all([
    getRecentWhoopDaily(14),
    getWhoopWorkoutsBetween(monday, sunday),
    getRecentAppleHealth(14),
    getRecentScreentime(14),
  ]);

  const dayset = new Set(opts.days);

  const whoopByDate = new Map<string, WhoopDailyLite>();
  for (const w of whoopDailies) {
    if (!dayset.has(w.date)) continue;
    whoopByDate.set(w.date, {
      date: w.date,
      recovery: w.recovery,
      wakeTime: w.wakeTime,
      bedTime: w.bedTime,
    });
  }

  const workoutsLite: WhoopWorkoutLite[] = workouts.filter((w) => dayset.has(w.date));

  // Apple Health: keep the max steps per date across sources (Whoop's own
  // sync into Apple Health double-counts iPhone steps, so per-source rows
  // can report different totals — max gets us closest to real-world).
  const stepsByDate = new Map<string, number>();
  for (const r of healthRows) {
    if (!dayset.has(r.date)) continue;
    const cur = stepsByDate.get(r.date) ?? 0;
    if (r.steps > cur) stepsByDate.set(r.date, r.steps);
  }

  // Screen time: per-day clean-up matching the dashboard PHONE tile.
  //   1. Drop "category" rollup rows (otherwise they double-count per-app rows).
  //   2. Within (date,source,label) keep the latest by syncedAt.
  //   3. Across sources, collapse to one row per (date, displayAppName)
  //      preferring mac_launchd — mac surfaces iOS too via Share Across Devices.
  const screentimeByDate = new Map<string, ScreentimeLite[]>();
  for (const day of opts.days) {
    const stage1 = new Map<string, ScreentimeLite>();
    for (const r of screentimeRows) {
      if (r.date !== day) continue;
      if (r.category === "category") continue;
      const key = `${r.date}|${r.source}|${r.label}`;
      const existing = stage1.get(key);
      if (!existing || r.syncedAt > existing.syncedAt) {
        stage1.set(key, {
          date: r.date,
          source: r.source,
          label: r.label,
          minutes: r.minutes,
          syncedAt: r.syncedAt,
        });
      }
    }
    const stage2 = new Map<string, ScreentimeLite>();
    for (const row of stage1.values()) {
      const key = `${row.date}|${displayAppName(row.label)}`;
      const ex = stage2.get(key);
      if (!ex) { stage2.set(key, row); continue; }
      const exIsMac = ex.source === "mac_launchd";
      const newIsMac = row.source === "mac_launchd";
      if (newIsMac && !exIsMac) stage2.set(key, row);
    }
    // Re-key screentime rows to display name so the evaluator's bundle
    // sets match either a bundle id or a friendly name.
    const display: ScreentimeLite[] = Array.from(stage2.values()).map((r) => ({
      ...r,
      label: displayAppName(r.label),
    }));
    screentimeByDate.set(day, display);
  }

  return {
    weekId: opts.weekId,
    days: opts.days,
    whoopByDate,
    workouts: workoutsLite,
    stepsByDate,
    screentimeByDate,
  };
}
