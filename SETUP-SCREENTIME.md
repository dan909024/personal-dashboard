# Screen Time setup

The dashboard accepts screen-time data from three sources, all posting
to `POST /api/screentime/ingest`:

- **iOS Shortcut Personal Automation** — fires daily at 23:55 from your
  iPhone. Always-on, no laptop needed. Source: `ios_shortcut`.
- **Mac launchd / knowledgeC.db job** — runs every 4h while the Mac is
  awake. Reads the local activity DB. Strong on Mac apps; iOS apps
  appear only sometimes via Share Across Devices.
  Source: `mac_launchd`.
- **Mac UI scrape of iPhone activity** — runs daily at 21:00. Opens
  System Settings → Screen Time, switches the device popup to your
  iPhone, scrapes the App & Website Activity table directly from the
  SwiftUI accessibility tree. Fills in iPhone-only app data that the
  knowledgeC.db job often misses. Briefly steals window focus
  (~3-5 minutes while it polls the SwiftUI lazy table). Source:
  `mac_ui_iphone`.

All three append into the **Screen Time** Sheet tab. The dashboard
PHONE tile reads from there.

> **Note:** the heartbeat-staleness check and weekly-summary inclusion
> referenced in earlier notes are not part of this PR — they're follow-up
> work after the pipeline is live.

---

## 1. Server-side prerequisite

Set this in **Vercel → Settings → Environment Variables** (and mirror
into `.env.local` for local dev):

| Var                          | Required | Notes                                                                 |
| ---------------------------- | -------- | --------------------------------------------------------------------- |
| `SCREENTIME_INGEST_SECRET`   | yes      | Long random string. Both iOS Shortcut + Mac collector send this.      |

Generate the secret:

```
openssl rand -hex 32
```

Redeploy after setting. The Sheet tab `Screen Time` is created
idempotently on the first ingest call.

---

## 2. iOS Shortcut (always-on source)

This Shortcut runs daily on your iPhone, reads Screen Time, and POSTs
to your dashboard. Build it in the **Shortcuts** app:

### Build the Shortcut

1. Open Shortcuts → tap **+** → name it **"Screen time → dashboard"**.
2. Add these actions in order:

   1. **Date** → set to *Current Date*. Then tap the date pill, choose
      **Get Component** → **Date** with format *2026-05-04* (ISO-style).
      This gives you today's date string.
   2. **Get Screen Time** → choose *Today*. Returns a `Screen Time`
      object with categories + apps.
   3. **Get Dictionary from Input** → pass the Screen Time result.
      Inside, build:
      ```
      {
        "date": <Date from step 1>,
        "tz": "Australia/Sydney",
        "source": "ios_shortcut",
        "items": [
          { "label": "Social",        "category": "category", "minutes": <Screen Time → Social → Minutes> },
          { "label": "Productivity",  "category": "category", "minutes": <Screen Time → Productivity → Minutes> },
          { "label": "Entertainment", "category": "category", "minutes": <Screen Time → Entertainment → Minutes> },
          { "label": "Telegram",      "category": "app",      "minutes": <Screen Time → Telegram → Minutes> }
        ]
      }
      ```
      Add per-app rows for whichever apps you want tracked individually
      (Telegram, Instagram, etc.). Apps you don't list still roll into
      the category totals.
   4. **Get Contents of URL**:
      - URL: `https://<your-vercel-domain>/api/screentime/ingest`
      - Method: **POST**
      - Headers:
        - `Authorization`: `Bearer <SCREENTIME_INGEST_SECRET>`
        - `Content-Type`: `application/json`
      - Request Body: **JSON** → use the dictionary from step 3.

3. Tap the play button to test once. You should see a `200` response
   in the Shortcut output and a new row appear in the Sheet within a
   minute.

### Schedule it (this is the "automation" part)

1. Shortcuts → **Automation** tab → **+** → **Personal Automation**.
2. Trigger: **Time of Day** → 11:55 PM → Daily.
3. Action: **Run Shortcut** → pick "Screen time → dashboard".
4. **Run Without Asking: ON.** (This is what makes it actually fire
   without a notification.)
5. Save.

You can verify the Automation will fire by tapping it in the list —
iOS shows the next scheduled run time.

---

## 3. Mac launchd (richer source, when laptop is open)

The Mac collector reads `~/Library/Application Support/Knowledge/knowledgeC.db`
— macOS's activity store. The file is owner-readable, but macOS TCC
still gates the launchd execution context: a process spawned by
launchd doesn't inherit Terminal.app's Full Disk Access grant, so
running the script from launchd hits `EPERM` on the SQLite copy until
FDA is granted to the actual leaf executable (`node`).

(Running the script interactively from Terminal works without any FDA
setup because Terminal.app already has the grant and child processes
inherit it. So a manual `npx tsx scripts/screentime-mac-sync.ts` is
fine for testing — only the launchd job needs the explicit grant.)

### One-time prerequisites

1. **Enable Screen Time on this Mac**: System Settings → Screen Time
   → toggle on.
2. **Enable cross-device sync**: same panel → **Share Across Devices**.
   Also turn it on in iPhone Settings → Screen Time. iOS app data will
   start surfacing in the Mac DB within minutes to hours, attributed to
   their iOS bundle ids.
3. **Grant Full Disk Access to your `node` binary**: System Settings →
   Privacy & Security → Full Disk Access → click **+**, press
   `Cmd+Shift+G`, and enter the absolute path to your node executable.
   On Homebrew/installer macOS that's typically `/usr/local/bin/node`
   (Intel) or `/opt/homebrew/bin/node` (Apple Silicon). Confirm with
   `which node`. Toggle the entry **on**.

   TCC tracks the leaf executable, not the wrapper script — so granting
   FDA to `/usr/bin/env` (the plist's entry point) does **not**
   propagate to `node`. Granting `node` itself is what unblocks the
   `copyfile` to the temp snapshot.

If your macOS version has moved the DB elsewhere (older macOS or a
future change), set `SCREENTIME_DB_PATH` in the plist to override.

### Install the launchd agent

1. Open
   [scripts/com.danielferrari.screentime-sync.plist](scripts/com.danielferrari.screentime-sync.plist)
   and replace every `REPLACE_*` placeholder:
   - `REPLACE_WITH_ABSOLUTE_PATH` → output of `pwd` from this repo (twice)
   - `REPLACE_WITH_HTTPS_URL/api/screentime/ingest` → your Vercel URL
   - `REPLACE_WITH_SHARED_SECRET` → same value as `SCREENTIME_INGEST_SECRET`
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

### If you change FDA after the job is already loaded

macOS caches a process's TCC profile when the launchd job is loaded —
toggling FDA later doesn't propagate until the job is fully unloaded
and reloaded. A `kickstart` alone isn't enough. The reload incantation:

```
launchctl bootout   gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
launchctl kickstart -k gui/$UID/com.danielferrari.screentime-sync
```

### To uninstall

```
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
rm ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
```

---

## 4. Mac UI scrape of iPhone activity (daily 21:00)

Drives the macOS System Settings → Screen Time pane, switches the
Device popup to "iPhone", and reads the App & Website Activity table.
This is the only path that reliably surfaces iPhone-side app data
(even with Share Across Devices on, knowledgeC.db often doesn't
contain it). Runs for ~3-5 minutes per execution, polling the
SwiftUI virtualised list to materialise as many rows as possible.
Window steals focus for the duration.

### One-time prerequisites

1. **Enable Screen Time + Share Across Devices on both devices**
   (same as section 3 — if section 3 is already working, this is
   already done).
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

The script:
1. Quits and relaunches System Settings (resets pane state).
2. Opens Screen Time → App & Website Activity.
3. Clicks the Device popup → selects iPhone.
4. Polls the SwiftUI list for ~3-5 minutes, accumulating row data
   as new rows lazy-render into the AX tree.
5. Translates "X hours, Y minutes" → integer minutes.
6. POSTs to `/api/screentime/ingest` with `source="mac_ui_iphone"`.

Output is logged to stdout (and to `/tmp/screentime-ui-sync.log`
when run from launchd — appends across runs, so it's a running log).

### Install the launchd agent

1. Open
   [scripts/com.danielferrari.screentime-ui-sync.plist](scripts/com.danielferrari.screentime-ui-sync.plist)
   and replace the `REPLACE_*` placeholders (same values as the
   knowledgeC.db plist):
   - `REPLACE_WITH_ABSOLUTE_PATH` → output of `pwd` (twice)
   - `REPLACE_WITH_HTTPS_URL/api/screentime/ingest` → your Vercel URL
   - `REPLACE_WITH_SHARED_SECRET` → same `SCREENTIME_INGEST_SECRET`
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

### Limitations

- **Today only.** The macOS Screen Time date popup on Sequoia 15.5
  exposes only "Today" and "This Week" — no "Yesterday" picker. The
  iOS Shortcut at 23:55 fills in yesterday's final number.
- **Top ~15-20 rows only.** The activity table is a SwiftUI
  virtualised list. AXScrollDownByPage on the surrounding scroll
  area is a no-op for the lazy list, system-level PageDown
  keystrokes don't reach the table because focus drifts after the
  device-popup click, and Quartz scroll-wheel events from a child
  process don't deliver reliably. The scraper falls back to polling
  what the OS lazy-renders on its own — typically the top 15-20
  apps, which captures the bulk of usage.
- **Friendly names, not bundle ids.** Rows arrive with display names
  ("Telegram Messenger", "Revolut: Spend, send and save") rather
  than bundle ids. Dashboard dedup keys on app name, so a
  `mac_ui_iphone` row may not collapse with a `mac_launchd`
  bundle-id row of the same app — both will show until we add a
  name → bundle-id alias map.

---

## 5. Verify end-to-end

1. After the iOS Shortcut runs (or you tap play once), refresh the
   dashboard. The **PHONE** tile should show today's top apps.
2. The **Screen Time** tab in the Sheet should have new rows.
3. The `/screentime` page shows source per row — look for `iOS`,
   `Mac`, and `iPhone (UI)` badges depending on which jobs ran.
