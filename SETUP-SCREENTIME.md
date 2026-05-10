# Screen Time setup

The dashboard collects screen-time data from two Mac-side jobs, both
posting to `POST /api/screentime/ingest`:

| Source key       | What it captures                                       | When it runs                              |
| ---------------- | ------------------------------------------------------ | ----------------------------------------- |
| `mac_launchd`    | Mac app usage (Terminal, Safari, Atlas, etc.)          | Every 4 h while the Mac is awake          |
| `mac_ui_iphone`  | iPhone app usage scraped from System Settings UI       | Every 2 min, gated by idle + 4h cooldown  |

Both append into the **Screen Time** Sheet tab. The dashboard PHONE
tile and the `/screentime` page read from there.

> **The iOS path that this doc previously described doesn't exist.**
> macOS/iOS Shortcuts on your account does not expose a "Get Screen
> Time" action, so the iPhone-driven path is fictional. The Mac UI
> scrape is the only working iPhone-data source. (Source key
> `ios_shortcut` is still allowed by the ingest route for historical
> reasons — if you ever build a working iPhone shortcut, it'll just
> work.)

---

## 1. Server-side prerequisite

Set this in **Vercel → Settings → Environment Variables** (and mirror
into `.env.local` for local dev):

| Var                          | Required | Notes                                                                 |
| ---------------------------- | -------- | --------------------------------------------------------------------- |
| `SCREENTIME_INGEST_SECRET`   | yes      | Long random string. Both Mac jobs send this.                          |

Generate the secret:

```
openssl rand -hex 32
```

Redeploy after setting. The Sheet tab `Screen Time` is created
idempotently on the first ingest call.

---

## 2. Mac launchd / knowledgeC.db (Mac apps)

The Mac collector reads `~/Library/Application Support/Knowledge/knowledgeC.db`
— macOS's app activity store. Captures Mac apps reliably; iPhone apps
sometimes appear via "Share Across Devices" but it's been observed
unreliable on macOS 15+, which is why we have the UI scrape (section 3).

The file is owner-readable, but macOS TCC still gates the launchd
execution context: a process spawned by launchd doesn't inherit
Terminal.app's Full Disk Access grant, so running the script from
launchd hits `EPERM` on the SQLite copy until FDA is granted to the
actual leaf executable (`node`).

(Running the script interactively from Terminal works without any FDA
setup because Terminal.app already has the grant and child processes
inherit it. So a manual `npx tsx scripts/screentime-mac-sync.ts` is
fine for testing — only the launchd job needs the explicit grant.)

### One-time prerequisites

1. **Enable Screen Time on this Mac**: System Settings → Screen Time
   → toggle on.
2. **Enable cross-device sync**: same panel → **Share Across Devices**.
   Also turn it on in iPhone Settings → Screen Time. (Even with this
   on, iPhone apps don't reliably show up in knowledgeC.db on
   macOS 15+ — the UI scrape in section 3 is what actually delivers
   iPhone data.)
3. **Grant Full Disk Access to your `node` binary**: System Settings →
   Privacy & Security → Full Disk Access → click **+**, press
   `Cmd+Shift+G`, and enter the absolute path to your node executable.
   On Homebrew/installer macOS that's typically `/usr/local/bin/node`
   (Intel) or `/opt/homebrew/bin/node` (Apple Silicon). Confirm with
   `which node`. Toggle the entry **on**.

### Install the launchd agent

1. Open
   [scripts/com.danielferrari.screentime-sync.plist](scripts/com.danielferrari.screentime-sync.plist)
   and replace every `REPLACE_*` placeholder.
2. Copy into LaunchAgents:
   ```
   cp scripts/com.danielferrari.screentime-sync.plist \
      ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
   ```
3. Load it:
   ```
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
   ```
4. Trigger immediately to verify:
   ```
   launchctl kickstart -k gui/$UID/com.danielferrari.screentime-sync
   tail -f /tmp/screentime-sync.log
   ```

---

## 3. Mac UI scrape of iPhone activity (the iPhone data path)

This is how iPhone usage actually reaches the dashboard. The scraper
opens System Settings → Screen Time → App & Website Activity, switches
the Device popup to your iPhone, and reads the activity table directly
from the SwiftUI accessibility tree. POSTs with `source="mac_ui_iphone"`.

### How it stays out of your way

launchd fires every 2 minutes, but each invocation is gated:

| Gate              | Default       | Override env                    |
| ----------------- | ------------- | ------------------------------- |
| Idle gate         | 120 s HID idle | `SCREENTIME_UI_IDLE_S`         |
| Cooldown          | 4 h since last success | `SCREENTIME_UI_COOLDOWN_S` |
| Lock              | one in flight | (file at `~/.screentime-scraper/lock`) |

So most invocations exit silently in <1 s. A real scrape only fires
when you've been idle ≥2 min AND the last successful scrape was ≥4 h
ago. The scrape itself takes 3-5 minutes and DOES take over your active
Space (this is unavoidable — see "Why no background mode" below).

There's a **"Refresh iPhone screen time" button** on the `/screentime`
page that bypasses both gates if you want to force a scrape on demand.
It writes a timestamp to a Sheet cell that the next launchd fire reads;
latency is up to 2 minutes + the 3-5 min scrape duration.

### One-time prerequisites

1. **Enable Screen Time + Share Across Devices on both devices** (same
   as section 2 — if section 2 is already working, this is already
   done).
2. **Grant Accessibility to `/usr/bin/osascript`**: System Settings →
   Privacy & Security → Accessibility → click **+**, press
   `Cmd+Shift+G`, enter `/usr/bin/osascript`, add it, toggle on.

   TCC tracks the leaf binary that opens the AX connection — the
   wrappers in the launchd plist (`env`, `npx`, `tsx`, `node`) don't
   count. The scraper exec's `osascript` directly, so that's the
   binary that needs the grant.

   For interactive runs from Terminal, Terminal.app needs the grant
   instead (the parent process inherits its TCC profile).

### Manual run

```
SCREENTIME_INGEST_URL=https://<your-vercel>/api/screentime/ingest \
SCREENTIME_INGEST_SECRET=... \
npm run screentime:ui
```

Output is logged to stdout (and to `/tmp/screentime-ui-sync.log` when
run from launchd, append-mode).

### Install the launchd agent

1. Open
   [scripts/com.danielferrari.screentime-ui-sync.plist](scripts/com.danielferrari.screentime-ui-sync.plist)
   and replace the `REPLACE_*` placeholders (same values as the
   knowledgeC.db plist).
2. Copy + load:
   ```
   cp scripts/com.danielferrari.screentime-ui-sync.plist \
      ~/Library/LaunchAgents/com.danielferrari.screentime-ui-sync.plist
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-ui-sync.plist
   ```
3. Trigger immediately to verify:
   ```
   launchctl kickstart -k gui/$UID/com.danielferrari.screentime-ui-sync
   tail -f /tmp/screentime-ui-sync.log
   ```

To uninstall:
```
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-ui-sync.plist
rm ~/Library/LaunchAgents/com.danielferrari.screentime-ui-sync.plist
```

### Why no background / hidden / off-screen mode

We tested every plausible way to make this scrape invisible. None work:

- **Off-Space window** (System Settings on Desktop 2 while you're on
  Desktop 1): SwiftUI's lazy-virtualised activity table only renders
  when the window is on the active Space. AX queries return
  `Can't get object`.
- **Off-screen window** (position -2400,-2400): single-snapshot
  scrapes work, but the polling loop's repeated AX walks run 4-5x
  slower off-screen and blow past the 10-min osascript timeout.
- **`yabai` cross-Space window control**: requires partial SIP
  disable, blocked by Vanta on this work machine.

So the scrape DOES take over your active Space for 3-5 minutes. The
idle gate ensures this only happens when you're not at the keyboard,
which is the substitute for invisibility.

### Limitations

- **Top ~14-17 rows.** The activity table is a SwiftUI virtualised
  list; the scraper captures the rows the OS lazy-renders (typically
  the top 14-17 apps by minutes). Long-tail apps (each <5 min) are
  missed. Tried scroll wheel / PageDown / AXScrollDownByPage — all
  dead ends. Captures ~83-90% of total iPhone usage minutes.
- **Today only.** macOS Screen Time's date popup on Sequoia 15.5
  exposes only "Today" and "This Week" — no per-day backfill.
- **Friendly names.** Rows arrive as App Store display names
  ("Telegram Messenger", "Revolut: Spend, send and save"). The
  display layer maps these to canonical names so they collapse with
  bundle-id rows from `mac_launchd` (see
  `src/lib/screentime-display.ts` `APP_NAME_ALIASES`).

---

## 4. Verify end-to-end

1. After a scrape posts, refresh the dashboard. The **PHONE** tile
   should show today's top apps with iPhone-side ones present
   (Instagram, Telegram Messenger, etc., not just Mac apps).
2. The **Screen Time** tab in the Sheet should have new rows.
3. The `/screentime` page shows source per row — `Mac` for
   knowledgeC.db, `iPhone (UI)` for the UI scrape.
