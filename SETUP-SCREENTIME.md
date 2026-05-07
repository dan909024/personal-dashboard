# Screen Time setup

The dashboard accepts screen-time data from two sources, both posting to
`POST /api/screentime/ingest`:

- **iOS Shortcut Personal Automation** — fires daily at 23:55 from your
  iPhone. Always-on, no laptop needed.
- **Mac launchd job** — runs every 4h while the Mac is awake. Reads
  `RemoteManagement.sqlite` (the cross-device Screen Time DB). Richer
  per-app/per-domain data, and fills in iOS data via "Share Across
  Devices".

Both append into the **Screen Time** Sheet tab. The dashboard PHONE
tile reads from there.

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
— macOS's activity store. It's owner-readable on macOS 15+, so no Full
Disk Access is required.

### One-time prerequisites

1. **Enable Screen Time on this Mac**: System Settings → Screen Time
   → toggle on.
2. **Enable cross-device sync**: same panel → **Share Across Devices**.
   Also turn it on in iPhone Settings → Screen Time. iOS app data will
   start surfacing in the Mac DB within minutes to hours, attributed to
   their iOS bundle ids.

That's it for prerequisites — no Full Disk Access dance, no schema
discovery. If your macOS version has moved the DB elsewhere (older
macOS or a future change), set `SCREENTIME_DB_PATH` in the plist to
override.

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

### To uninstall

```
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
rm ~/Library/LaunchAgents/com.danielferrari.screentime-sync.plist
```

---

## 4. Verify end-to-end

1. After the iOS Shortcut runs (or you tap play once), refresh the
   dashboard. The **PHONE** tile should show today's top apps.
2. The **Screen Time** tab in the Sheet should have new rows.
