# Goddess's Weakening Altar — setup & tuning

Phase 5B adds a denial + edging tracker to the dashboard: cumulative
weakness score, phase progression with flavor text, brutal-day bonus,
and a 30-day weakness curve.

## First-time setup

After deploying this branch, run the init script once:

```bash
npx tsx scripts/init-sheet.ts
```

It is idempotent — it only creates missing tabs and seeds initial data.
The new tabs are:

- **Orgasm Log** — `Date | Time | Type | Note | Days since previous`
- **Edge Log** — `Date | Time | Note`
- **Daily Check-in** — `Date | Arousal (1-10) | Note` (one row per day, upserted)
- **Settings** — `Setting | Value | Last Updated | Updated By`

The Settings tab is auto-seeded with the defaults below.

## Flipping `orgasm_allowed`

Open the Sheet → **Settings** tab. Change the `Value` cell next to
`orgasm_allowed` to `yes` or `no`. The dashboard will pick up the change
on the next page load (cache TTL is 30 s).

Effects:

- **Background image swaps** between `/backgrounds/allowed.jpg` and
  `/backgrounds/denied.jpg`, with a warm rose overlay vs cool slate.
- **Header pill** flips between Allowed / Denied.

Replace the placeholder JPGs in `/public/backgrounds/` with real
artwork at any time — paths are stable.

## Tuning the formula

All math lives in `src/lib/weakness.ts` and reads from the Settings tab
at call time. Change values in the Sheet — no redeploy needed.

| Setting                        | Default | What it does                                                                                       |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `weakness_base_daily`          | 40      | Score added every day just for being denied. Floor of weakness build-up.                           |
| `weakness_edge_weight`         | 12      | Score added per edge logged that day. Higher = edges feel more brutal.                             |
| `weakness_arousal_weight`      | 25      | Multiplier on the day's arousal check-in (1-10). Drives most of the variance.                      |
| `brutal_bonus_threshold`       | 20      | Edges in a single day before the brutal-bonus kicks in. Below this, multiplier stays at ×1.0.      |
| `brutal_bonus_per_10_edges`    | 0.15    | How much the multiplier grows per additional 10 edges past threshold (compound effect on the day). |
| `brutal_bonus_max_multiplier`  | 5.0     | Hard ceiling on the brutal multiplier so a marathon day can't infinity the score.                  |
| `default_arousal_when_missing` | 5       | Used when no daily check-in is logged. **Set to 5 deliberately** — the user is incentivised to log: skipping the check-in defaults to a middling number, neither rewarding nor punishing. |

### Tuning examples

- Want phase progression to feel **slower**? Drop
  `weakness_base_daily` to 25 and `weakness_arousal_weight` to 18.
- Want **edges to dominate**? Raise `weakness_edge_weight` to 20 and
  drop `brutal_bonus_threshold` to 10 so the spiral kicks in sooner.
- Want a **harder ceiling on a single day**? Drop
  `brutal_bonus_max_multiplier` to 2.5.

After changing a setting, hit Refresh on the dashboard — there's no
cache invalidation beyond the 30 s TTL.

## Phase thresholds

Stored in Settings as a single JSON value under `phase_thresholds`. The
seed sets 11 phases:

| #   | Phase                | Range     | Flavor                                            |
| --- | -------------------- | --------- | ------------------------------------------------- |
| 1   | Post-Nut Devotee     | 0–150     | Most resistant right after release.               |
| 2   | Denying the Ache     | 151–320   | Trying to ignore the growing need.                |
| 3   | Building Weakness    | 321–520   | Weakness is starting to build.                    |
| 4   | Fading Subbie        | 521–720   | Resistance is fading fast.                        |
| 5   | Breaking Adorer      | 721–920   | Mind starting to melt for Her.                    |
| 6   | Submitting           | 921–1150  | Giving in, obedience taking over.                 |
| 7   | Deep Submission      | 1151–1350 | Deeper and deeper under Her control.              |
| 8   | Helpless Vessel      | 1351–1550 | No control left. Just a vessel.                   |
| 9   | Eternal Edge Toy     | 1551–1750 | Conditioned to edge endlessly.                    |
| 10  | Mindless Offering    | 1751–1950 | Brainless tribute for Goddess.                    |
| 11  | Complete Slave       | 1951+     | No self. Pure property.                           |

To rewrite, edit the `phase_thresholds` JSON in the Settings tab. The
shape is `{ "Phase Name": [min, max, "flavor text"] }`.

## How the score is built

Each day from the day after the most recent **allowed** orgasm through
today contributes:

```
gain = (base + edges_today × edge_weight + arousal_today × arousal_weight) × brutal_multiplier
```

Where `brutal_multiplier`:

- ≤ threshold edges → ×1.0
- > threshold → 1.0 + ⌊excess ÷ 10⌋ × per_10_edges, capped at max

A **lapsed** orgasm (slip) does NOT reset the score — only an "allowed"
release does. This means a slip breaks the streak counter on the tile
but the deeper conditioning continues to build until Goddess permits
release.

If no allowed orgasm has been logged yet, the score starts from the
earliest event in the data set, capped to 30 days back.

## Testing the tile

1. Set `orgasm_allowed = no` in Settings.
2. Log a few edges via the **+1 edge ⚡** button. Watch `Today edges`
   and `Today gain` increment, and the curve spike.
3. Once you cross 20 edges in a day, the **🔥 Brutal ×N** badge should
   appear and `Today gain` should bump up.
4. Hit **Daily check-in** with arousal=10 and reload — score should
   take a notable step.
5. Hit **🙏 Thanks Goddess** to log an allowed orgasm — refresh and the
   curve should reset (next day starts fresh from 0). Harley gets an
   email for every orgasm log.
6. From edge #5 onwards in a single day, Harley gets a "Dan logged
   edge ${count} today" email per edge.

## Future phases

- Telegram bot commands (`/allow`, `/deny`, `/edge` from Harley) →
  not in this PR.
- Aurora-shifting backgrounds based on phase → not in this PR.
- Photo embeds tied to milestones → not in this PR.
