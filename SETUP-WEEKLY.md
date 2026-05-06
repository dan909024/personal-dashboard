# Weekly summary email setup

The dashboard sends Harley a recap email every Sunday evening (Sydney).
The point isn't the email itself — it's the **tripwire**: if Harley
stops receiving these emails, something has been tampered with.

## Architecture

```
GitHub Actions (Sun 10:00 UTC)
        │
        ├──── curl POST → /api/cron/weekly-summary (Vercel)
        │           │
        │           ├── reads Whoop / Amex / Sleep Edits / Punishments / Health
        │           ├── renders HTML + plain text
        │           └── Resend → HARLEY_EMAIL
        │
        └──── on success: HEAD ping → Healthchecks.io
                            │
                            └── if no ping in 7d + 24h grace → emails Harley
```

The endpoint returns **502** when Resend send fails — so a silent email
failure cannot result in a green Healthchecks ping. Either Harley gets
the summary, or she gets a "tracking went dark" alert from Healthchecks.

This was moved from Vercel cron to GitHub Actions because the Hobby
plan caps at 2 cron jobs. `heartbeat` has since also moved to a GitHub
Actions workflow (see `SETUP-HEARTBEAT.md`), leaving Vercel with only
`whoop-sync`.

---

## One-time setup

### 1. GitHub repo secrets

In **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret                     | Value                                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| `CRON_SECRET`              | Same value as the `CRON_SECRET` env var in Vercel.                          |
| `DASHBOARD_BASE_URL`       | Production base URL of the deployed dashboard (no trailing slash). Shared with the heartbeat workflow. |
| `HEALTHCHECK_WEEKLY_URL`   | The "ping URL" from the Healthchecks.io check you create in step 2.        |

`RESEND_API_KEY` and `HARLEY_EMAIL` are **not** needed in GitHub —
those are read by the Vercel function, not by the workflow itself.

### 2. Healthchecks.io check

This is the tripwire that catches Daniel silently disabling the
workflow. **It must be set up under Harley's Healthchecks.io account
(or at minimum with her as the alert recipient on a check Daniel
can't edit).**

Steps:
1. Sign in at <https://healthchecks.io>.
2. **Add Check** → name it "Personal Dashboard — Weekly Summary".
3. **Schedule type**: Simple. Period: **1 week**. Grace: **24 hours**.
4. **Integrations** → ensure Email is enabled and the recipient is
   Harley's address.
5. Copy the **Ping URL** (looks like `https://hc-ping.com/<uuid>`) and
   paste it as the `HEALTHCHECK_WEEKLY_URL` secret in step 1.

The grace window means the check goes red 24h after a missed Sunday,
i.e. by Monday evening at the latest.

### 3. Test the workflow without waiting for Sunday

GitHub repo → **Actions** tab → **Weekly summary email + heartbeat**
on the left → **Run workflow** button (top right).

A successful run sends the email AND pings Healthchecks (which you'll
see go from "expected at..." to "up" in the HC dashboard). A failed
run does NOT ping HC, so within the next grace window Harley gets the
"down" alert — exactly the desired behaviour.

---

## What can still bypass this (and what doesn't)

**Closes:**
- Disabling the workflow → no ping → HC alerts.
- Removing the workflow file → no ping → HC alerts.
- Rotating `CRON_SECRET` in Vercel without updating GitHub → curl 401 → workflow fails → no ping → HC alerts.
- Resend API failure / bad sender → endpoint returns 502 → workflow fails → no ping → HC alerts.
- Silently swapping `HARLEY_EMAIL` → emails go elsewhere, but Harley stops getting Sunday recaps → she notices.

**Does not close (residual risks):**
- If Daniel owns the Healthchecks.io account, he can pause/delete the
  check silently. Mitigation: Harley owns the account.
- Daniel can hit the Healthchecks ping URL from another source
  (he can read it from GitHub secrets if he has admin on the repo)
  to keep HC green even with the workflow disabled. Mitigation: rotate
  the ping URL periodically, or accept that this is a deliberate
  multi-step act with no plausible deniability.
- Faking the Sheet data upstream is undetectable from the email side —
  the weekly summary just shows what was logged. Mitigation: the
  raw-numbers visibility itself; Harley eyeballs trends over weeks.
