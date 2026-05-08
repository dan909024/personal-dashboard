#!/usr/bin/env osascript -l JavaScript
//
// Discovery script for the macOS Screen Time settings pane (JXA).
//
// Opens System Settings → Screen Time, waits for it to render, and dumps
// the accessibility tree of the front window so we can see what UI
// elements actually exist on this macOS version before writing the
// real scraper.
//
// Run:
//   osascript -l JavaScript scripts/screentime-ui-discover.js > /tmp/screentime-ax.txt 2>&1
//
// First run triggers an Accessibility permission prompt for whatever
// shell launches osascript. Grant it in System Settings → Privacy &
// Security → Accessibility, then re-run.

const MAX_DEPTH = 8;
const APP = Application.currentApplication();
APP.includeStandardAdditions = true;

function run() {
  const app = APP;
  let log = "";
  try {
    app.doShellScript("open 'x-apple.systempreferences:com.apple.Screen-Time-Settings.extension'");
    sleep(3.0);

    const se = Application("System Events");
    const proc = se.processes["System Settings"];
    log += `proc exists=${!!proc}\n`;
    try { proc.frontmost = true; } catch (e) { log += `frontmost set failed: ${e.message}\n`; }
    sleep(1.5);

    const wins = proc.windows();
    log += `windows count=${wins.length}\n`;
    if (wins.length === 0) return log + "no windows yet";
    const win = wins[0];
    log += `window name=${safe(() => win.name())} title=${safe(() => win.title())}\n`;
    return log + "\n---tree---\n" + dump(win, 0);
  } catch (e) {
    return log + `\nFATAL: ${e.message}\nstack=${e.stack || "(none)"}`;
  }
}

function safe(fn) { try { return String(fn()); } catch (e) { return `<err:${e.message}>`; } }

function dump(elem, depth) {
  if (depth > MAX_DEPTH) return "";
  const indent = "  ".repeat(depth);
  let line = indent;
  try { line += String(elem.role()) || "?"; } catch (e) { line += "?"; }
  line += attr(elem, "subrole", "subrole");
  line += attr(elem, "identifier", "id");
  line += attr(elem, "title", "title");
  line += attr(elem, "description", "desc");
  line += attr(elem, "value", "value");
  line += attr(elem, "help", "help");
  let out = line + "\n";

  let kids = [];
  try { kids = elem.uiElements(); } catch (e) { /* ignore */ }
  for (const k of kids) {
    out += dump(k, depth + 1);
  }
  return out;
}

function attr(elem, prop, label) {
  try {
    const v = elem[prop]();
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!s) return "";
    if (s.length > 200) return ` ${label}="${s.slice(0, 200)}…"`;
    return ` ${label}="${s}"`;
  } catch (e) {
    return "";
  }
}

function sleep(seconds) {
  APP.doShellScript(`sleep ${seconds}`);
}
