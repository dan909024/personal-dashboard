// One-off: dump recent Harley Payments rows.
import https from "node:https";
https.globalAgent.options.family = 4;
import { readFileSync } from "node:fs";

function loadDotEnvLocal(path = ".env.local"): void {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined || process.env[m[1]] === "") {
        process.env[m[1]] = v;
      }
    }
  } catch { /* ignore */ }
}
loadDotEnvLocal();

async function main() {
  const lib = await import("../src/lib/sheets");
  const days = Number(process.argv[2] || 90);
  const rows = await lib.getRecentHarleyPayments(days);
  console.log(`HARLEY PAYMENTS (last ${days}d, ${rows.length} rows)`);
  if (rows.length === 0) {
    console.log("  (none yet)");
    return;
  }
  let usdc = 0, usdt = 0;
  for (const r of rows) {
    const cur = (r.currency || "").toUpperCase();
    if (cur === "USDC") usdc++;
    else if (cur === "USDT") usdt++;
    console.log(`  ${r.date} | ${cur || "?"} ${r.amount} | net=${r.network || "-"} | msgId=${(r.emailId || "").slice(0, 30)}`);
  }
  console.log(`\nBy currency: USDT=${usdt}, USDC=${usdc}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
