# Nutrition tile — protein / calories / water

Phase 5C: a NUTRITION tile that surfaces today's dietary protein, calories
consumed, and water intake against tunable daily targets. Reads from the
Apple Health rows that the iOS Auto Export shortcut already pushes — no
new endpoint, no manual entry.

## How it works

```
MyFitnessPal / Cronometer / etc
   ↓ (writes to HealthKit dietaryProtein, dietaryEnergyConsumed, dietaryWater)
HealthKit
   ↓ (Auto Export iOS Shortcut on the user's phone)
Auto Export Shortcut
   ↓ (POST /api/health/ingest with the new fields)
Apple Health sheet tab (cols I, J populated alongside existing Water col H)
   ↓
getDashboardNutrition() (cached 60s)
   ↓
NUTRITION tile (3 progress bars)
```

Auto Export already pushes water (col H). For protein and calories
consumed, you need to update the Shortcut to read the additional
HealthKit samples and include them in the JSON body.

## iOS Shortcut payload — new fields

The ingest route accepts these in addition to everything it already takes:

| JSON key | HealthKit source | Units | Notes |
| --- | --- | --- | --- |
| `protein` | `dietaryProtein` | grams | sum across the day; `proteinSamples` array also accepted |
| `caloriesConsumed` or `dietaryEnergy` | `dietaryEnergyConsumed` | kcal | sum across the day; `caloriesConsumedSamples` / `dietaryEnergySamples` also accepted |

If the Shortcut runs mid-day before the day's macro logging is up to
date, the ingest preserves the prior reading rather than overwriting
with zero — same behaviour as `water`.

### Example body

```json
{
  "date": "2026-05-08",
  "steps": 8420,
  "activeCalories": 487,
  "restingCalories": 1830,
  "water": 2400,
  "protein": 148,
  "caloriesConsumed": 2210,
  "workouts": []
}
```

## Daily targets

Stored in the **Settings** tab. Edit the `Value` cell to retune without
redeploy.

| Setting | Default | Meaning |
| --- | --- | --- |
| `nutrition_protein_target_g` | 221 | Daily protein target in grams. |
| `nutrition_calorie_target` | 2940 | Daily kcal target (calories consumed, not burned). |
| `nutrition_water_target_ml` | 3350 | Daily water target in millilitres. |

Defaults match Daniel's own targets. The reader (`getWeaknessSettings`)
falls back to these in-code defaults if the Settings rows are missing,
so the tile renders correctly even before you run the seed script.

To seed the Settings tab with these rows explicitly:

```bash
npx tsx scripts/seed-weakness-settings.ts
```

## Tile behaviour

Three rows, each `value / target unit` with a colour-graded progress bar:

- **<60% of target** → grey bar
- **60–94%** → amber
- **≥95%** → green

If the latest reading isn't from today (e.g. Shortcut hasn't run yet),
the tile falls back to the most recent day with data and prints a small
amber line below: `showing 2026-05-07 — no data for today yet`.

## Adjusting the Shortcut (one-time)

In the Auto Export Shortcut on your iPhone:

1. Edit the action that reads HealthKit samples for water.
2. Add two more "Find Health Samples" / "Filter Health Samples" actions:
   - One for `Dietary Protein` (last 24 hours, all sources).
   - One for `Dietary Energy` (last 24 hours, all sources).
3. Sum each (using the "Statistics on Health Samples" action if your
   Shortcuts version has it; otherwise pass the raw samples as the
   `proteinSamples` / `caloriesConsumedSamples` array — the ingest
   route handles both).
4. Add the new fields to the JSON body that gets POSTed to
   `/api/health/ingest`.
