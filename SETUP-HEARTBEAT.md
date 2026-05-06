# Heartbeat setup

A GitHub Actions workflow pings `/api/cron/heartbeat` every 5 minutes.
The endpoint checks Sheets/Whoop plumbing, writes a System Health row,
optionally pings Healthchecks.io, and emails Harley if anything is
broken (with 6h dedupe).

## Architecture

```
GitHub Actions (every 5 min)
        │
        ├──── curl GET → $DASHBOARD_BASE_URL/api/cron/heartbeat (Vercel)
        │           │
        │           ├── checks Sheets configured, Whoop tokens, last sync age
        │           ├── appends row to "System Health" sheet
        │           └── on failure → Resend email to Harley (6h dedupe)
        │
        └──── on success: HEAD ping → Healthchecks.io
                            │
                            └── if no ping in 5min + grace → emails Harley
```

This was moved from Vercel cron to GitHub Actions because the Vercel
Hobby plan caps cron jobs at 2 (`whoop-sync` keeps the only remaining
slot). GitHub Actions is free and unlimited on public repos.

---

## Required GitHub Actions secrets

In **GitHub repo → Settings → Secrets and variables → Actions**:

| Secret                       | Value                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `CRON_SECRET`                | Same value as `CRON_SECRET` env var in Vercel. Already set.                          |
| `DASHBOARD_BASE_URL`         | **NEW** — production base URL of the deployed dashboard (no trailing slash).         |
| `HEALTHCHECK_HEARTBEAT_URL`  | Ping URL of the Healthchecks.io "Personal Dashboard Heartbeat" check. Already set.   |

`DASHBOARD_BASE_URL` is also used by the weekly summary workflow, so
adding it once unblocks both.

---

## Healthchecks.io check

The existing **"Personal Dashboard Heartbeat"** check now expects a
ping every 5 minutes from this GitHub Action instead of from Vercel
cron. If the check was previously updated to expect daily pings (when
heartbeat was temporarily moved to daily on Vercel), update it back:

- **Schedule type**: Simple
- **Period**: 5 minutes
- **Grace**: 15 minutes

Anything stricter risks false positives from GitHub Actions queueing
delays (cron schedules in GH Actions are best-effort, not exact).

---

## Test the workflow without waiting

GitHub repo → **Actions** tab → **System heartbeat (every 5 min)**
→ **Run workflow** button.

A successful run hits the endpoint AND pings Healthchecks. A failing
endpoint (non-200) fails the job, which skips the HC ping, which trips
the alert within the grace window.
