/**
 * One-shot helper that resets the denial countdown to 30 days from now,
 * stamped with the current Sydney offset.
 *
 * Usage (from project root, with .env.local populated):
 *   npx tsx scripts/set-denial-30-days.ts
 *
 * Reads/writes the "Denial" tab via setDenialEndDate(). The dashboard's
 * /api/denial route is unstable_cache-tagged with revalidate: 30, so the
 * UI reflects the new value within ~30s (or after a refresh).
 */
import { readFileSync } from "node:fs";

function loadDotEnvLocal(path = ".env.local"): void {
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/);
    if (!m) continue;
    process.env[m[1]] = m[2];
  }
}
loadDotEnvLocal();

function formatSydneyOffsetISO(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const datePart = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const tz = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00";
  return `${datePart}${tz.replace("GMT", "")}`;
}

async function main() {
  const { setDenialEndDate } = await import("../src/lib/sheets");
  const target = new Date(Date.now() + 30 * 86_400_000);
  const iso = formatSydneyOffsetISO(target);
  console.log(`Setting denial_end_date → ${iso}`);
  await setDenialEndDate(iso);
  console.log("✓ Updated. UI will pick up the new target within ~30s.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
