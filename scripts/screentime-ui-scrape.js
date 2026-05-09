#!/usr/bin/env osascript -l JavaScript
//
// Mac → iPhone Screen Time UI scraper.
//
// Companion to scripts/screentime-mac-sync.ts (which reads
// knowledgeC.db for Mac data). knowledgeC.db doesn't reliably
// surface iOS apps even with "Share Across Devices" on, so this
// scraper opens System Settings → Screen Time → App & Website
// Activity, switches the device popup to "iPhone", and reads the
// activity table directly from the SwiftUI accessibility tree.
//
// Tested on macOS 15.5 (Sequoia). The Settings UI uses stable
// AXIdentifiers — "appAndWebsiteActivityView", "mostUsedTable",
// "mostUsedTableNameText", "mostUsedTableTimeText",
// "mostUsedTablePicker", "usageHeaderView" — that have been
// consistent across recent macOS releases.
//
// Output: JSON to stdout, structure
//   { ok: true, device, date, total, picker, rows: [{name, time}, ...] }
// or { ok: false, error: "...", stage: "..." } on failure.
//
// Manual run:
//   osascript -l JavaScript scripts/screentime-ui-scrape.js
//
// Driven by scripts/screentime-ui-sync.ts which parses the JSON,
// translates "X hours, Y minutes" to integer minutes, and POSTs
// to /api/screentime/ingest.
//
// Permissions required: Accessibility for whichever process
// launches osascript (Terminal for interactive runs, osascript
// itself for the launchd job — the leaf binary).

const APP = Application.currentApplication();
APP.includeStandardAdditions = true;

const NAV_DELAY = 4;       // seconds after opening Screen Time
const SWITCH_DELAY = 3;    // seconds after switching device/picker
const MENU_DELAY = 0.7;    // seconds after pressing a popup
const SCROLL_DELAY = 1.2;  // seconds between scroll attempts
const SCROLL_MAX = 30;     // safety cap on scroll iterations
const SCROLL_QUIET = 6;    // stop after this many consecutive zero-additions (table is virtualised + lazy)
const TARGET_DEVICE_REGEX = /iPhone/i;

function run() {
  try {
    return JSON.stringify(main());
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message, stack: e.stack || null });
  }
}

function main() {
  // Hard reset System Settings — it loves to return to a stale
  // pane on relaunch otherwise.
  APP.doShellScript("osascript -e 'tell application \"System Settings\" to quit' || true");
  APP.doShellScript("sleep 2");
  APP.doShellScript("osascript -e 'tell application \"System Settings\" to activate'");
  APP.doShellScript("sleep 1");
  APP.doShellScript("open 'x-apple.systempreferences:com.apple.Screen-Time-Settings.extension'");
  APP.doShellScript(`sleep ${NAV_DELAY}`);

  const se = Application("System Events");
  const proc = se.processes["System Settings"];

  // Wait for window to actually appear — System Settings sometimes
  // launches with no window (on first launch after quit) and needs an
  // extra second or two before the URL-deep-link materialises one.
  let winReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      if (proc.windows().length > 0) { winReady = true; break; }
    } catch (e) {}
    APP.doShellScript("sleep 1");
  }
  if (!winReady) {
    return { ok: false, error: "Screen Time window did not appear within 10s of opening", stage: "launch" };
  }

  // Step 1: press the first card on the Screen Time root pane.
  // Empirically (macOS 15.5) this is "App & Website Activity".
  pressFirstActivityCard(proc);
  APP.doShellScript(`sleep ${SWITCH_DELAY + 1}`);

  // Step 2: switch the Device popup to iPhone. (After "Share Across
  // Devices" is enabled, the menu offers per-device entries.)
  const deviceSwitched = switchPopup(proc, isDevicePopup, TARGET_DEVICE_REGEX);
  if (!deviceSwitched) {
    return { ok: false, error: "could not switch device popup to iPhone — is 'Share Across Devices' enabled and has the iPhone synced recently?", stage: "device_switch" };
  }
  // Longer post-switch wait: SwiftUI lazy-loads rows for several
  // seconds after the device change. The polling loop below catches
  // any that materialise late, but a longer initial wait reduces
  // total runtime.
  APP.doShellScript(`sleep 4`);

  // Step 3: scrape with polling.
  //
  // The mostUsedTable is a SwiftUI virtualised list. We tried three
  // ways to scroll past the viewport — AXScrollDownByPage on the
  // outer scroll area was a no-op, system-level PageDown keystrokes
  // didn't reach the table because focus drifted after the device
  // popup click, and Quartz scroll-wheel events posted from a child
  // process didn't deliver (likely a TCC permissions issue and a
  // significant invocation cost). All three are dead ends without
  // additional setup, so the scraper falls back to a simple polling
  // loop that captures the rows the OS lazy-renders into the AX
  // tree on its own. In practice this is ~12-17 rows — the top
  // apps by minutes, which is what matters for the dashboard tile.
  //
  // The full list (typically 30-50 apps) only surfaces if the user
  // has manually scrolled the pane within the same System Settings
  // session. See SETUP-SCREENTIME.md for the limitation.
  const merged = { device: "", date: "", picker: "", total: "", windowTitle: "", rows: [] };
  const seen = new Map(); // name -> {name, time}

  function mergeFrom(snapshot) {
    let added = 0;
    if (snapshot.device && !merged.device) merged.device = snapshot.device;
    if (snapshot.date && !merged.date) merged.date = snapshot.date;
    if (snapshot.picker && !merged.picker) merged.picker = snapshot.picker;
    if (snapshot.total && !merged.total) merged.total = snapshot.total;
    if (snapshot.windowTitle && !merged.windowTitle) merged.windowTitle = snapshot.windowTitle;
    for (const r of snapshot.rows) {
      if (!seen.has(r.name)) { seen.set(r.name, r); added++; }
    }
    return added;
  }

  mergeFrom(scrape(proc.windows[0]));
  let quiet = 0;
  for (let i = 0; i < SCROLL_MAX; i++) {
    APP.doShellScript(`sleep ${SCROLL_DELAY}`);
    const added = mergeFrom(scrape(proc.windows[0]));
    if (added === 0) {
      quiet += 1;
      if (quiet >= SCROLL_QUIET) break;
    } else {
      quiet = 0;
    }
  }
  merged.rows = Array.from(seen.values());

  if (!merged.device) {
    return { ok: false, error: "scrape produced no device — view did not settle", stage: "scrape" };
  }

  return Object.assign({ ok: true }, merged);
}



function pressFirstActivityCard(proc) {
  const win = proc.windows[0];
  const split = win.uiElements()[0].uiElements()[0];
  const sk = split.uiElements();
  let right = null;
  for (let i = sk.length - 1; i >= 0; i--) {
    if (axA(sk[i], "AXRole") === "AXGroup") { right = sk[i]; break; }
  }
  if (!right) throw new Error("right pane not found");
  let scroll = null;
  walkOnce(right, e => { if (axA(e, "AXRole") === "AXScrollArea" && !scroll) scroll = e; });
  if (!scroll) throw new Error("scroll area not found");
  const kids = scroll.uiElements();
  let firstBtn = null;
  for (let i = 0; i < kids.length - 1; i++) {
    if (axA(kids[i], "AXRole") === "AXHeading") {
      const inner = kids[i + 1].uiElements();
      for (const b of inner) if (axA(b, "AXRole") === "AXButton") { firstBtn = b; break; }
      break;
    }
  }
  if (!firstBtn) throw new Error("first activity card not found");
  firstBtn.actions.byName("AXPress").perform();
}

// ---------- Popup switching ----------

function isDevicePopup(elem) {
  if (axA(elem, "AXRole") !== "AXPopUpButton") return false;
  if (axA(elem, "AXIdentifier") === "mostUsedTablePicker") return false;
  const v = axA(elem, "AXValue") || "";
  // Device value is one of "All Devices", "Daniel's iPhone",
  // "MacBook Pro", etc. Distinguish from the date popup (which
  // always has a "Today, ..." / weekday / "This Week" pattern)
  // and the picker (handled above).
  if (/iPhone|iPad|Mac/.test(v)) return true;
  if (v === "All Devices") return true;
  return false;
}

function switchPopup(proc, popupPred, itemRegex) {
  const root = proc.windows[0];
  let path = findPath(root, popupPred);
  if (!path) return false;

  let popup = resolveByPath(proc.windows[0], path);
  popup.actions.byName("AXPress").perform();
  APP.doShellScript(`sleep ${MENU_DELAY}`);

  popup = resolveByPath(proc.windows[0], path);
  let menus = [];
  try { menus = popup.menus(); } catch (e) {}
  if (!menus.length) {
    Application("System Events").keyCode(53);
    return false;
  }

  let target = null;
  try {
    const items = menus[0].menuItems();
    for (const m of items) {
      const t = axA(m, "AXTitle") || axA(m, "AXValue") || "";
      if (itemRegex.test(t)) { target = m; break; }
    }
  } catch (e) {}

  if (!target) {
    Application("System Events").keyCode(53);
    return false;
  }
  target.actions.byName("AXPress").perform();
  return true;
}

// ---------- Scrape ----------

function scrape(root) {
  const out = { device: "", date: "", picker: "", total: "", windowTitle: axA(root, "AXTitle") || "", rows: [] };
  let inTable = false;
  let currentRow = null;

  function visit(elem, depth) {
    if (depth > 18) return;
    const role = axA(elem, "AXRole");
    const id = axA(elem, "AXIdentifier");
    const subrole = axA(elem, "AXSubrole");
    const value = axA(elem, "AXValue");

    if (role === "AXPopUpButton" && value) {
      if (id === "mostUsedTablePicker" || /^Show /i.test(value)) {
        if (!out.picker) out.picker = value;
      } else if (value === "All Devices" || /iPhone|iPad|Mac/.test(value)) {
        if (!out.device) out.device = value;
      } else {
        if (!out.date) out.date = value;
      }
    }
    if (id === "usageHeaderView" && role === "AXStaticText" && value) out.total = value;

    let weEntered = false;
    if (id === "mostUsedTable") { inTable = true; weEntered = true; }
    if (inTable && role === "AXRow" && subrole === "AXOutlineRow") {
      currentRow = { name: "", time: "" };
    }
    if (inTable && currentRow && id === "mostUsedTableNameText" && value) currentRow.name = value;
    if (inTable && currentRow && id === "mostUsedTableTimeText" && value) currentRow.time = value;

    let kids = [];
    try { kids = elem.uiElements(); } catch (e) { /* virtualization */ }
    for (const k of kids) visit(k, depth + 1);

    if (inTable && role === "AXRow" && subrole === "AXOutlineRow") {
      // Drop the synthetic "All Usage" summary row — its name is "All
      // Usage" with the total time, which we already capture as `total`.
      if (currentRow && currentRow.name && currentRow.name !== "All Usage" && currentRow.time) {
        out.rows.push(currentRow);
      }
      currentRow = null;
    }
    if (weEntered) inTable = false;
  }

  visit(root, 0);
  return out;
}

// ---------- Tree helpers ----------

function findPath(root, pred) {
  let result = null;
  function dfs(e, path) {
    if (result) return;
    try { if (pred(e)) { result = path; return; } } catch (er) {}
    let kids = [];
    try { kids = e.uiElements(); } catch (er) {}
    for (let i = 0; i < kids.length; i++) {
      dfs(kids[i], [...path, i]);
      if (result) return;
    }
  }
  dfs(root, []);
  return result;
}

function resolveByPath(root, path) {
  let c = root;
  for (const i of path) c = c.uiElements()[i];
  return c;
}

function walkOnce(elem, fn, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 16 || !elem) return;
  try { fn(elem); } catch (e) {}
  let kids = [];
  try { kids = elem.uiElements(); } catch (e) {}
  for (const k of kids) walkOnce(k, fn, depth + 1);
}

function axA(e, n) {
  try {
    const v = e.attributes.byName(n).value();
    return v == null ? null : String(v);
  } catch (er) { return null; }
}
