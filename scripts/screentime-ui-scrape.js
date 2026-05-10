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

function quitSystemSettings() {
  // Best-effort. We don't care about the result — if the app isn't
  // running this is a no-op, and if it fails we'd rather continue
  // than throw out of a finally block.
  try {
    APP.doShellScript("osascript -e 'tell application \"System Settings\" to quit' || true");
  } catch (e) { /* ignore */ }
}

function main() {
  try {
    return mainBody();
  } finally {
    // Quit on every exit path — success, early-return failure, or
    // uncaught exception. Without this, a scrape that bails before
    // reaching the success-path cleanup leaves Settings on screen.
    quitSystemSettings();
  }
}

function mainBody() {
  // Foreground scrape — the constraints we proved empirically and
  // the trade-offs they force:
  //
  //   1. SwiftUI's lazy virtualised list (the activity table) only
  //      materialises rows when the System Settings window is on the
  //      user's active macOS Space. Off-Space → "Can't get object"
  //      from AX.
  //   2. The table renders fine when the window is off-screen
  //      (verified: 24 rows captured at -2400,-2400) — but the
  //      polling LOOP's repeated AX walks run 4-5x slower off-screen
  //      and blow past the 10-min osascript timeout. So off-screen
  //      polling is a no-go.
  //   3. Popup menus render at the popup button's pixel position; if
  //      the window is off-screen the menu items render off-screen
  //      too and the device-switch fails.
  //   4. Cross-Space window manipulation requires yabai's scripting
  //      addition, which needs partial SIP disable — blocked by
  //      Vanta on this work machine.
  //
  // Net: window stays on the active Space, fully visible, throughout
  // the 3-5 min scrape. The idle gate in the TS driver
  // (~/.screentime-scraper/state + ioreg HID idle) ensures the user
  // isn't at the keyboard when this happens. The wrapping main()
  // try/finally guarantees Settings is quit regardless of how this
  // body exits. The dashboard refresh button bypasses the idle gate
  // when the user explicitly wants a fresh row now (and has chosen
  // to step away).
  APP.doShellScript("osascript -e 'tell application \"System Settings\" to quit' || true");
  // Longer post-quit settle: a previous failed run may have left the
  // app in a half-quitting state. The "Can't get object" intermittent
  // failure correlated with quick back-to-back invocations; 4 s lets
  // the prior process actually exit.
  APP.doShellScript("sleep 4");
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

  // Snapshot the initial state — device popup defaults to "All
  // Devices" on this macOS version. Capturing the total here lets
  // us detect when the table actually re-renders post device-switch
  // (the value changes from the All-Devices total to the iPhone-only
  // total). Without this verification we hit a SwiftUI race: the
  // popup's text label updates instantly but the table data lags
  // 5-10 seconds, and our scrape captured stale combined data
  // labelled as "iPhone".
  let initialDevice = "?";
  let initialTotal = "";
  try { initialDevice = readPopupValue(proc, isDevicePopup) || "?"; } catch (e) {}
  try { initialTotal = readUsageTotal(proc) || ""; } catch (e) {}
  console.log(`[scrape] initial device=${redactPersonal(initialDevice)} total=${initialTotal}`);

  // Step 2: switch the Device popup to iPhone. (After "Share Across
  // Devices" is enabled, the menu offers per-device entries.)
  const deviceSwitched = switchPopup(proc, isDevicePopup, TARGET_DEVICE_REGEX);
  if (!deviceSwitched) {
    return { ok: false, error: "could not switch device popup to iPhone — is 'Share Across Devices' enabled and has the iPhone synced recently?", stage: "device_switch" };
  }

  // Wait for the table to actually re-render to iPhone-only data.
  // We poll the usage total: when it differs from the captured
  // initial (All Devices) total, SwiftUI has loaded the new data.
  // Cap at 20 seconds — if the total never changes, the iPhone
  // view may legitimately equal the All-Devices view (rare, e.g.
  // user only used iPhone today), so we proceed regardless and
  // note it.
  let postSwitchTotal = "";
  let waitedS = 0;
  for (let i = 0; i < 40; i++) {
    APP.doShellScript("sleep 0.5");
    waitedS = (i + 1) * 0.5;
    try { postSwitchTotal = readUsageTotal(proc) || ""; } catch (e) {}
    if (postSwitchTotal && postSwitchTotal !== initialTotal) break;
  }
  let postSwitchDevice = "?";
  try { postSwitchDevice = readPopupValue(proc, isDevicePopup) || "?"; } catch (e) {}
  console.log(
    `[scrape] post-switch device=${redactPersonal(postSwitchDevice)} total=${postSwitchTotal} (waited ${waitedS}s, total ${postSwitchTotal === initialTotal ? "UNCHANGED — possible race" : "changed"})`
  );

  // Step 2.5: collect rows ON-screen first.
  //
  // The mostUsedTable is a SwiftUI virtualised list — rows
  // materialise lazily as the table renders. On-screen the AX
  // walks are fast (~1.5 s each), so we poll for SETTLE_S seconds
  // and merge as rows come in. After this we have the bulk of
  // the data in `seen` and can confidently move off-screen.
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

  // SHORT on-screen polling phase to capture as many rows as the
  // OS lazy-renders. Off-screen AX walks are 4-5x slower (verified)
  // and blow past the osascript timeout, so we do most of the
  // collection here while the window is still visible.
  const ONSCREEN_SETTLE_ITERS = 8;
  mergeFrom(scrape(proc.windows[0]));
  let quiet = 0;
  for (let i = 0; i < ONSCREEN_SETTLE_ITERS; i++) {
    APP.doShellScript(`sleep ${SCROLL_DELAY}`);
    const added = mergeFrom(scrape(proc.windows[0]));
    if (added === 0) {
      quiet += 1;
      if (quiet >= SCROLL_QUIET) break;
    } else {
      quiet = 0;
    }
  }

  // Step 4: shove the window off-screen, take ONE final walk to
  // catch any rows that lazy-rendered after we stopped polling, then
  // quit. We don't poll repeatedly off-screen because each off-screen
  // AX walk is 4-5x slower than on-screen — empirically verified
  // that 30 polling iterations hit the 10-min osascript timeout.
  // One final walk only adds ~10 s and reaps a few late rows.
  try {
    proc.windows[0].position = [-2400, -2400];
    APP.doShellScript("sleep 1.5");
    mergeFrom(scrape(proc.windows[0]));
  } catch (e) { /* tolerate — we still have what on-screen produced */ }

  merged.rows = Array.from(seen.values());

  // (Settings is quit by main()'s finally block — covers every exit
  // path, not just this success branch.)

  if (!merged.device) {
    return { ok: false, error: "scrape produced no device — view did not settle", stage: "scrape" };
  }

  return Object.assign({ ok: true }, merged);
}

// Redact personal identifiers from a string before logging it. The
// device popup label tends to be "Daniel's iPhone" / "Daniel's MacBook"
// — strip the personal name fragment so /tmp/screentime-ui-sync.log
// doesn't carry it across disk. Mirror of the TS driver's
// PERSONAL_REDACT_REGEX. Keep the two in sync if you add terms.
// See memory: feedback_personal_identifier_redaction.md
function redactPersonal(s) {
  if (!s) return s;
  // Strip name + optional possessive 's so "Daniel's iPhone" → "iPhone"
  // (not "s iPhone" which a naive replace would produce).
  return String(s)
    .replace(/\b(avid|pubsuite|daniel|ferrari)(['’]s)?\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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

// ---------- Reads (used by the verification logic in main) ----------

// Walk the window tree and return the AXValue of the first
// AXPopUpButton matching the predicate. Used to read the device
// popup's current label without affecting it.
function readPopupValue(proc, popupPred) {
  let result = null;
  walkOnce(proc.windows[0], e => {
    if (result) return;
    try {
      if (axA(e, "AXRole") === "AXPopUpButton" && popupPred(e)) {
        const v = axA(e, "AXValue");
        if (v) result = v;
      }
    } catch (er) {}
  });
  return result;
}

// The big "X hours, Y minutes" text above the activity table.
function readUsageTotal(proc) {
  let result = null;
  walkOnce(proc.windows[0], e => {
    if (result) return;
    if (axA(e, "AXIdentifier") === "usageHeaderView" &&
        axA(e, "AXRole") === "AXStaticText") {
      const v = axA(e, "AXValue");
      if (v) result = v;
    }
  });
  return result;
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
