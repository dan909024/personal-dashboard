#!/usr/bin/env bash
#
# Aggressive Screen Time discovery — find where iOS-via-Share-Across-Devices
# data actually lives on this Mac. The Settings → Screen Time UI shows iOS
# app usage, so the data IS on disk somewhere; this script triangulates it
# three ways so we don't miss it:
#
#   1. lsof every Screen Time / usage-tracking daemon → see which .db files
#      they have open right now. Whatever Apple's own UI reads from is the
#      ground truth.
#   2. Recently-modified .db / .sqlite files in ~/Library — narrows the
#      candidate set to stores with data actively flowing in.
#   3. knowledgeC.db: dump distinct ZSTREAMNAME values + row counts. Maybe
#      iOS data is in there but in a non-`/app/usage` stream the current
#      collector isn't querying (`/device/usage`, `/cross/`, etc.).
#
# Prereqs: Full Disk Access on Terminal (or whatever runs this).
# Read-only. No data leaves the machine unless you paste it.
#
# Run:
#   bash scripts/screentime-discover-v2.sh > /tmp/screentime-discover-v2.txt 2>&1
#   pbcopy < /tmp/screentime-discover-v2.txt   # then paste back

set -u
set -o pipefail

KNOWLEDGE_DB="$HOME/Library/Application Support/Knowledge/knowledgeC.db"
TMP_DIR="$(mktemp -d -t screentime-discover-v2.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

section() {
  echo
  echo "==== $1 ===="
}

# ---------- 1. Live processes + their open DB files ----------

section "1a. Screen Time / usage-tracking processes"
ps aux | grep -iE "screentime|usagetracking|coreduet|knowledge" | grep -v grep | awk '{print $2, $11}'

section "1b. Open .db / .sqlite files for each"
for proc_pat in "ScreenTimeAgent" "usagetrackingagent" "CoreDuetD" "CoreDuetDaemon" "knowledgeC" "Settings"; do
  pids=$(pgrep -f "$proc_pat" 2>/dev/null)
  for pid in $pids; do
    name=$(ps -p "$pid" -o comm= 2>/dev/null | xargs -I {} basename {} 2>/dev/null)
    files=$(lsof -p "$pid" 2>/dev/null | grep -E "\.(db|sqlite)" | awk '{print $NF}' | sort -u)
    if [ -n "$files" ]; then
      echo "--- pid $pid ($name) ---"
      echo "$files"
    fi
  done
done

# ---------- 2. Recently-modified DBs in user Library ----------

section "2. .db / .sqlite files in ~/Library modified in the last 14 days, >1KB"
find "$HOME/Library" -type f \( -name "*.db" -o -name "*.sqlite" \) \
  -mtime -14 -size +1k 2>/dev/null \
  | while read -r f; do
      sz=$(stat -f "%z" "$f" 2>/dev/null)
      mt=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$f" 2>/dev/null)
      printf "  %s  %10s bytes  %s\n" "$mt" "$sz" "$f"
    done | sort

section "3. knowledgeC.db: distinct streams + row counts"
if [ ! -f "$KNOWLEDGE_DB" ]; then
  echo "knowledgeC.db not at expected path: $KNOWLEDGE_DB"
else
  cp "$KNOWLEDGE_DB" "$TMP_DIR/k.db" 2>/dev/null
  for suf in -wal -shm; do
    [ -f "$KNOWLEDGE_DB$suf" ] && cp "$KNOWLEDGE_DB$suf" "$TMP_DIR/k.db$suf" 2>/dev/null
  done
  if [ ! -f "$TMP_DIR/k.db" ]; then
    echo "Failed to copy knowledgeC.db. Probably FDA missing."
  else
    # Distinct streams + row counts. Streams with iOS-related data
    # often have prefixes like /device/, /cross/, /portrait/, etc.
    sqlite3 -header -column "$TMP_DIR/k.db" \
      "SELECT ZSTREAMNAME, COUNT(*) AS rows
         FROM ZOBJECT
        GROUP BY ZSTREAMNAME
        ORDER BY rows DESC
        LIMIT 60;"

    section "3b. knowledgeC.db: distinct app labels in /app/usage (top 30 by row count)"
    sqlite3 -header -column "$TMP_DIR/k.db" \
      "SELECT ZVALUESTRING, COUNT(*) AS rows
         FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
        GROUP BY ZVALUESTRING
        ORDER BY rows DESC
        LIMIT 30;"

    section "3c. knowledgeC.db: any streams matching /device|/cross|/share|/portrait|/family"
    sqlite3 -header -column "$TMP_DIR/k.db" \
      "SELECT ZSTREAMNAME, COUNT(*) AS rows, MIN(DATE(ZSTARTDATE+978307200,'unixepoch','localtime')) AS oldest, MAX(DATE(ZSTARTDATE+978307200,'unixepoch','localtime')) AS newest
         FROM ZOBJECT
        WHERE ZSTREAMNAME LIKE '/device%' OR ZSTREAMNAME LIKE '/cross%' OR ZSTREAMNAME LIKE '/share%' OR ZSTREAMNAME LIKE '/portrait%' OR ZSTREAMNAME LIKE '/family%'
        GROUP BY ZSTREAMNAME
        ORDER BY rows DESC;"

    section "3d. knowledgeC.db: 5 sample rows from each /device|/cross|/share stream that has data"
    sqlite3 -header -column "$TMP_DIR/k.db" \
      "SELECT ZSTREAMNAME, ZVALUESTRING, ZVALUEINTEGER, ZSTARTDATE, ZENDDATE
         FROM ZOBJECT
        WHERE ZSTREAMNAME LIKE '/device%' OR ZSTREAMNAME LIKE '/cross%' OR ZSTREAMNAME LIKE '/share%'
        ORDER BY ZSTARTDATE DESC
        LIMIT 30;"
  fi
fi

# ---------- 4. iOS-bundle-id sniff ----------
#
# If the Mac has any iOS bundle ids ANYWHERE in any sqlite DB under
# ~/Library, this finds them. iOS bundle id heuristic: contains
# "burbn" (Instagram), "tinder", "hinge", "bumble", "telegram", or
# generally the bundle id pattern "com.<vendor>.<app>" with a known
# iOS-only vendor.

section "4. Brute grep: which sqlite files contain iOS bundle ids?"
echo "(Scanning all .db/.sqlite under ~/Library for iOS bundle id strings; this can take ~30-60s)"
ios_signals='com\.burbn\.|com\.atebits\.Tweetie|com\.toyopagroup\.picaboo|com\.cardify\.tinder|co\.match\.tinder|com\.hinge\.app|com\.bumble\.app|com\.zhiliaoapp\.musically|com\.facebook\.Facebook|com\.facebook\.Messenger|com\.netflix\.Netflix|com\.google\.ios\.youtube|com\.spotify\.client|com\.apple\.mobile(safari|mail|notes|cal|phone)|com\.apple\.MobileSMS|net\.whatsapp\.WhatsApp'
find "$HOME/Library" -type f \( -name "*.db" -o -name "*.sqlite" \) -size +50k 2>/dev/null | while read -r db; do
  if strings -a "$db" 2>/dev/null | grep -qE "$ios_signals"; then
    matches=$(strings -a "$db" 2>/dev/null | grep -oE "$ios_signals" | sort -u | head -10 | tr '\n' ',' | sed 's/,$//')
    sz=$(stat -f "%z" "$db" 2>/dev/null)
    echo "  HIT: $db ($sz bytes) → $matches"
  fi
done
echo "(scan complete)"

echo
echo "==== Discovery v2 done. ===="
