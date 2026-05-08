/**
 * Shared screen-time display helpers — bundle-id → friendly name,
 * minutes formatting, and source/cap badges. Used by both the PHONE
 * tile on the main dashboard and the /screentime breakdown page.
 *
 * The 1440-minute cap is applied server-side at /api/screentime/ingest;
 * any value at or near the cap is suspicious and gets a different
 * badge so it doesn't render as a normal "24h on Instagram today."
 */
import type { ScreenTimeRow } from "@/lib/sheets";

// Bundle id → friendly display name. Apps not listed here render as
// their raw label (bundle id from mac_launchd, or free-text from
// ios_shortcut). Add entries as new apps appear in the data.
export const APP_DISPLAY_NAMES: Record<string, string> = {
  // Mac apps
  "com.anthropic.claudefordesktop": "Claude Desktop",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.openai.atlas": "Atlas",
  "com.google.Chrome": "Chrome",
  "com.granola.app": "Granola",
  "com.daisydiskapp.DaisyDiskStandAlone": "DaisyDisk",
  "com.apple.Terminal": "Terminal",
  "com.apple.finder": "Finder",
  "com.apple.TextEdit": "TextEdit",
  "com.apple.Safari": "Safari",
  "com.apple.Photos": "Photos",
  "com.apple.MobileSMS": "Messages",
  "com.apple.systempreferences": "System Settings",
  "com.apple.shortcuts": "Shortcuts",
  "com.apple.ScreenContinuity": "Screen Continuity",
  // iOS apps that may surface via Share Across Devices
  "com.burbn.instagram": "Instagram",
  "com.atebits.Tweetie2": "X",
  "com.toyopagroup.picaboo": "Snapchat",
  "com.cardify.tinder": "Tinder",
  "co.match.tinder": "Tinder",
  "com.hinge.app": "Hinge",
  "com.bumble.app": "Bumble",
  "ru.keepcoder.Telegram": "Telegram",
  "com.apple.mobilesafari": "Safari",
  "com.apple.mobilemail": "Mail",
  "com.apple.mobilenotes": "Notes",
  "com.apple.mobilecal": "Calendar",
  "com.apple.mobilephone": "Phone",
  "com.spotify.client": "Spotify",
  "com.apple.podcasts": "Podcasts",
  "com.netflix.Netflix": "Netflix",
  "com.google.ios.youtube": "YouTube",
  "com.zhiliaoapp.musically": "TikTok",
  "com.facebook.Facebook": "Facebook",
  "com.facebook.Messenger": "Messenger",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "com.apple.iBooks": "Books",
  "com.apple.Maps": "Maps",
};

export function displayAppName(label: string): string {
  return APP_DISPLAY_NAMES[label] ?? label;
}

export function fmtPhoneMinutes(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "0m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

// Cap from the ingest endpoint. Values at or near it are clipped from
// the source side; we badge them as suspicious so 24h-Instagram doesn't
// look like a real number.
export const SCREENTIME_CAP_MINUTES = 24 * 60;
export const SCREENTIME_SUSPICIOUS_THRESHOLD = 18 * 60; // 18h

export function phoneBadge(minutes: number): "❓" | "⚠" | "✅" {
  if (minutes >= SCREENTIME_SUSPICIOUS_THRESHOLD) return "❓";
  if (minutes >= 60) return "⚠";
  return "✅";
}

/**
 * Drop iOS-Shortcut category-level rows. These are sent alongside per-app
 * rows for the same period (e.g. "Social" 200m and "Instagram" 80m where
 * Instagram is inside Social), so summing both double-counts.
 */
export function dropCategoryRows(rows: ScreenTimeRow[]): ScreenTimeRow[] {
  return rows.filter((r) => r.category !== "category");
}

/**
 * For each (date, app) collapse multiple sources to one row, preferring
 * mac_launchd over ios_shortcut. Mac surfaces both Mac usage and iOS
 * usage (via "Share Across Devices"), so its row tends to be the
 * superset; the iOS Shortcut row would otherwise double-count.
 */
export function dedupeAppsPreferMac(rows: ScreenTimeRow[]): ScreenTimeRow[] {
  const map = new Map<string, ScreenTimeRow>();
  for (const r of rows) {
    const key = `${r.date}|${displayAppName(r.label)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, r);
      continue;
    }
    const existingIsMac = existing.source === "mac_launchd";
    const newIsMac = r.source === "mac_launchd";
    if (newIsMac && !existingIsMac) map.set(key, r);
  }
  return Array.from(map.values());
}
