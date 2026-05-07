# Apple Health → Dashboard ingest

The dashboard's ROUTINE tile reads step counts from a Google Sheet
tab populated by an iOS Shortcut. This is a one-time setup on your
iPhone.

> **Workouts no longer come from this Shortcut.** The GYM tile is
> driven by the Whoop API server-side (daily whoop-sync cron) — Whoop
> reports strain reliably and Ladder doesn't expose workouts to Apple
> Health. You can still include a `workouts` field in the payload
> (the endpoint accepts it and stores it in the Apple Health tab),
> but the GYM tile ignores it. Steps-only Shortcuts are perfectly
> fine.

## Prerequisites

1. **Vercel env var** `APPLE_HEALTH_INGEST_SECRET` is set. Generate
   with `openssl rand -hex 32` and add to Production + Preview +
   Development scopes. Copy this value — you'll paste it into the
   Shortcut.
2. The dashboard is live at
   `https://personal-dashboard-six-tan.vercel.app` (or your prod URL).
3. **Health permissions for Shortcuts.** First time the Shortcut runs
   it will prompt for read access to Steps, Workouts, Active Energy,
   and Resting Energy. Grant all four.

## Build the Shortcut

Open the Shortcuts app on your iPhone → tap **+** to create a new
shortcut. Name it **"Sync to Dashboard"**. Add these actions in order:

### 1. Get today's date

- Action: **Date**
- Set to "Current Date"

### 2. Format date as YYYY-MM-DD

- Action: **Format Date**
- Input: the Date variable from step 1
- Format: **Custom**, with format string: `yyyy-MM-dd`
- Save the result as a variable named **`Today`**.

### 3. Get step count for today

- Action: **Find Health Samples Where**
- Sample type: **Steps**
- Filter: **Start Date** is today, **End Date** is today
- Sort: by Start Date, descending
- Limit: 0 (= no limit)
- Then add **Calculate Statistics on Health Samples** → operation
  **Sum**, save as **`Steps`**.

### 4. Get all workouts for today

- Action: **Find Workouts Where**
- Filter: **Start Date** is today
- Sort: Start Date, ascending
- Limit: 0
- Save as **`Workouts`**.

### 5. (Optional) Get active calories for today

- Action: **Find Health Samples Where**, sample type **Active Energy
  Burned**, today only.
- **Calculate Statistics** → Sum → save as **`ActiveCal`**.

### 6. (Optional) Get resting calories

- Same as step 5 but sample type **Resting Energy** → save as
  **`RestingCal`**.

### 7. Build a JSON payload

- Action: **Dictionary** (or **Get Dictionary from Input** + add
  values)
- Add these key/value pairs:

  | Key              | Type   | Value                                   |
  |------------------|--------|-----------------------------------------|
  | `date`           | Text   | `Today` variable                        |
  | `steps`          | Number | `Steps` variable                        |
  | `activeCalories` | Number | `ActiveCal` variable (or 0 if skipped)  |
  | `restingCalories`| Number | `RestingCal` variable (or 0 if skipped) |
  | `source`         | Text   | `ios-shortcut`                          |
  | `workouts`       | Array  | (see below)                             |

  For `workouts`, use **Repeat with Each** over the `Workouts`
  variable. In each iteration, build a sub-dictionary with:
  - `type`: workout activity name (Run, HIIT, etc.)
  - `durationMin`: workout duration converted to minutes
  - `source`: `apple-health`

  Append each sub-dictionary to the `workouts` array.

### 8. POST to the dashboard

- Action: **Get Contents of URL**
- URL: `https://personal-dashboard-six-tan.vercel.app/api/health/ingest`
- Method: **POST**
- Headers:
  - `Authorization`: `Bearer <PASTE APPLE_HEALTH_INGEST_SECRET HERE>`
  - `Content-Type`: `application/json`
- Request Body: **JSON** → use the dictionary from step 7

### 9. Show a notification with the result

- Action: **Show Notification**
- Title: "Dashboard sync"
- Body: the response from step 8 (status code or `action` field)

## Test it

Run the Shortcut manually from the Shortcuts app. You should see a
notification confirming `appended` (first run for today) or `updated`
(subsequent runs same day).

Open the Google Sheet → "Apple Health" tab. The row for today should
show your step count and any workouts as a JSON string.

Reload the dashboard. The GYM tile should reflect today's workouts and
streak; the ROUTINE tile should show steps.

## Schedule it

In Shortcuts, tap **Automation** → **+** → **Personal Automation** →
**Time of Day**.

- Time: **9:00 PM**
- Repeat: **Daily**
- Action: **Run Shortcut** → "Sync to Dashboard"
- Disable "Ask Before Running" so it runs silently.

You can also keep the manual trigger for ad-hoc syncs (e.g. right
after finishing a workout).

## Troubleshooting

- **401 unauthorized**: bearer token mismatch. Re-copy the value of
  `APPLE_HEALTH_INGEST_SECRET` from Vercel and paste it in the
  Authorization header (no extra whitespace, no quotes).
- **400 date must be YYYY-MM-DD**: the Format Date step is using the
  wrong format string. Use exactly `yyyy-MM-dd` (lowercase y, lowercase
  d).
- **Steps showing as 0**: Health permissions probably weren't granted
  to the Shortcuts app. Settings → Privacy & Security → Health →
  Shortcuts → enable Steps + Workouts.
- **Capped values**: the endpoint clamps steps at 100,000 and calories
  at 20,000 per day to absorb sensor glitches. Real values that high
  will appear as the cap.
