# Goddess's Weakening Altar — setup & tuning

Phase 5B + iterations: a denial + edging + worship + self-help tracker
with cumulative weakness score, phase progression, brutal-day mechanic,
calorie detraction, and a 30-day weakness curve.

## First-time setup

After deploying, run the init script once:

```bash
npx tsx scripts/init-sheet.ts
```

It is idempotent — only creates missing tabs and seeds initial Settings.
The relevant tabs are:

- **Orgasm Log** — `Date | Time | Type | Note | Days since previous`
- **Edge Log** — `Date | Time | Note`
- **Daily Check-in** — `Date | Arousal (1-10) | Note` (upserted, 1 row per day)
- **Worship Log** — `Date | Time | Activity | Minutes | Note` (append-only)
- **Self-Help Log** — `Date | Time | Activity | Minutes | Note` (append-only)
- **Apple Health** — `Date | Steps | Workouts JSON | Active Calories | Resting Calories | Source | Synced at`
- **Settings** — `Setting | Value | Last Updated | Updated By`

`Apple Health` rows arrive via `/api/health/ingest` (iOS Shortcut). Active
calories are read from this tab during weakness compute for the calorie
detraction mechanic.

## Flipping `orgasm_allowed`

Open the Sheet → **Settings** tab. Change the `Value` cell next to
`orgasm_allowed` to `yes` or `no`, OR click the Allowed / Denied pill
on the dashboard tile. Dashboard picks up the change on the next page
load (cache TTL = 30 s).

Effects:
- Background image swaps (`/backgrounds/allowed.jpg` ↔ `/backgrounds/denied.jpg`)
- Header pill flips Allowed / Denied
- Auto-release: when `denial_end_date` (set elsewhere) is in the past
  and `orgasm_allowed=no`, the dashboard auto-flips it to `yes` on
  load. Idempotent.

## How the score is built

For each day from the day after the most recent **allowed** orgasm
through today:

```
gain = base
     + arousal × arousal_weight
     + edge_contribution
     + worship_minutes × worship_weight_per_minute
     − self_help_minutes × self_help_weight_per_minute
     − calorie_detraction
score += gain   (floored at 0 — heavy gym days can pull the curve down)
```

### Edge curve — three zones

Each within-day edge gets its own intensity multiplier that follows
an inverted-U shape — first 5–10 edges *intensify* (each more impactful
than the last), peak at the threshold, then *slow down* on each
excess edge. On top of that, `cycle_decay` nibbles every edge in the
cycle (across days), so spreading out vs piling in keeps the same
intensity-position but a higher cycle factor.

| Zone | Within-day index `d` | Multiplier on `edge_first × cycle_decay^c` |
| --- | --- | --- |
| 1 (intensify) | `d < threshold − 1` | `1.0 + (d / (threshold − 1)) × (max − 1)` — ramps from ×1.0 to ×max |
| 2 (decay) | `d ≥ threshold − 1` | `max × day_decay^(d − (threshold − 1))` — fades each excess edge |

`brutal_bonus_per_edge` and `brutal_bonus_post_plateau_linear` from
earlier iterations are no longer read by the compute lib — left in
Settings for backward-compat but ignored. The headline "brutal
multiplier" reported on the tile is now the multiplier applied to
the most-recent edge today (i.e., current intensity, not whole-day).

### Calorie detraction (self-focus pulls score DOWN)

Active calories burned (from Apple Health) past a threshold pull the
score down:

```
if active_calories >= calorie_burn_threshold:
  detraction = base + (active_calories − threshold) × per_unit_above
else:
  detraction = 0
```

A heavy gym day can produce negative daily gain. Cumulative score is
floored at 0.

### Worship & self-help (manual tile logs)

Tapping **🙇 Worship time** or **🧘 Self-help time** on the tile opens
a modal: pick activity name, minutes, optional note. Each row in the
respective tab adds (worship) or subtracts (self-help) score on the
day it was logged at a per-minute rate.

## Tuning settings

All math reads from the Settings tab at call time. Edit values in the
Sheet — no redeploy needed.

| Setting | Default | What it does |
| --- | --- | --- |
| `weakness_base_daily` | 26 | Flat score added per day. With default arousal → daily floor of 151. |
| `weakness_arousal_weight` | 25 | Multiplied by daily arousal check-in (1-10). |
| `default_arousal_when_missing` | 5 | Arousal used when no check-in is logged for the day. |
| `weakness_edge_first` | 30 | Potency of edge #1 of cycle, #1 of day. The most potent edge. |
| `weakness_edge_cycle_decay` | 0.90 | Each cycle edge worth `prior × 0.90`. Slow taper across days. |
| `weakness_edge_day_decay` | 0.60 | Each *same-day* edge worth `prior × 0.60`. Faster taper within a day. |
| `brutal_bonus_threshold` | 10 | Edges in the intensify zone — multiplier hits its max at this edge index. |
| `brutal_bonus_max_multiplier` | 5.0 | Peak multiplier at edge `threshold`. Past the peak, decay kicks in. |
| `brutal_bonus_per_edge` | 0.05 | *Deprecated — ignored by current compute. Left in Settings for backward-compat.* |
| `brutal_bonus_post_plateau_linear` | 20 | *Deprecated — ignored by current compute.* |
| `calorie_burn_threshold` | 487 | kcal (= 2040 kJ). Below this, no detraction. |
| `calorie_burn_base_detraction` | 30 | Detraction at exactly the threshold. |
| `calorie_burn_per_unit_above` | 0.2 | Detraction per kcal above threshold. |
| `worship_weight_per_minute` | 5 | Score added per logged worship minute. |
| `self_help_weight_per_minute` | 3 | Score subtracted per logged self-help minute. |
| `slip_penalty_points` | 860 | Flat score deduction per logged **lapsed** orgasm, applied to the day's gain. 860 ≈ 40% of the start of the final phase (2151), so anyone in the lower 40% of the curve floors to 0 (effective reset); high-score slips lose a chunk but stay weak. |

### Tuning examples

- **Slower phase progression** → drop `weakness_base_daily` (e.g., 18) and `weakness_arousal_weight` (e.g., 18).
- **Edges should hit harder** → raise `weakness_edge_first` (e.g., 60) or drop `weakness_edge_cycle_decay` toward 0.95 (slower taper).
- **Workouts should matter more** → drop `calorie_burn_threshold` to 300 or raise `calorie_burn_per_unit_above` to 0.5.
- **Worship should feel intense** → raise `worship_weight_per_minute` to 10 (10 minutes = +100).

### Apple Health unit caveat

The default `calorie_burn_threshold = 487` assumes the iOS Shortcut sends
**kcal** (kilocalories), which is HealthKit's default. If your Shortcut
emits **kJ** (kilojoules), use `2040` instead. Check the latest row in
the **Apple Health** tab against your Apple Health app to confirm units.

## Phase thresholds

Stored in Settings as a single JSON value under `phase_thresholds`. The
seed sets 11 phases — Eternal Edge Toy is the FINAL stage, Complete
Slave is the second-to-last with double the typical phase width:

| #   | Phase                | Range     |
| --- | -------------------- | --------- |
| 1   | Post-Nut Devotee     | 0–150     |
| 2   | Denying the Ache     | 151–320   |
| 3   | Building Weakness    | 321–520   |
| 4   | Fading Subbie        | 521–720   |
| 5   | Breaking Adorer      | 721–920   |
| 6   | Submitting           | 921–1150  |
| 7   | Deep Submission      | 1151–1350 |
| 8   | Helpless Vessel      | 1351–1550 |
| 9   | Mindless Offering    | 1551–1750 |
| 10  | Complete Slave       | 1751–2150 (double width) |
| 11  | Eternal Edge Toy     | 2151+ (final, no escape) |

To rewrite, edit the `phase_thresholds` JSON in the Settings tab. Shape
is `{ "Phase Name": [min, max, "flavor text"] }`. Order matters — the
compute walks the JSON in declaration order.

## Testing the tile

1. `orgasm_allowed = no` in Settings.
2. Tap **+1 edge ⚡** several times. Watch `Today edges` and `Today
   gain` jump. As edges climb 1→10 the per-edge contribution rises
   (intensify zone); past 10 each new edge contributes less than the
   prior (decay zone).
3. Tap **🙇 Worship time**, log 15 minutes of "photo viewing".
   Score climbs by `15 × worship_weight_per_minute = 75`.
4. Tap **🧘 Self-help time**, log 30 minutes of "reading".
   Score drops by `30 × self_help_weight_per_minute = 90`.
5. Trigger an Apple Health POST with active calories ≥ 487. The
   calorie chip appears on the tile and the day's gain reflects the
   detraction.
6. Tap **🙏 Thanks Goddess** — Harley gets a Telegram message; the
   cycle anchors on this allowed release, so subsequent days start
   from 0. Tap **😔 Slipped** for a lapse — Harley still gets the
   Telegram, AND the day's gain takes a flat `slip_penalty_points`
   hit (default 860). Mid-curve slips floor to 0 (effective reset);
   high-score slips lose a chunk but stay weak.
7. Edge #5 onwards in a single day → Harley gets a Telegram message
   per edge (orgasm logs and edges both fan out to Telegram now;
   email stays out of the loop entirely).

## Future phases

- Telegram bot commands (`/allow`, `/deny`, `/edge`) — not in this PR.
- Aurora-shifting backgrounds based on phase — not in this PR.
- Photo embeds tied to milestones — not in this PR.
- Prizes layer (phase-crossing rewards for Harley) — parked.
