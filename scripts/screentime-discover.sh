#!/usr/bin/env bash
#
# Read-only discovery for the macOS Screen Time SQLite database. We need
# to see the schema (and a tiny sample of rows) before we can write the
# real SQL in scripts/screentime-mac-sync.ts.
#
# Prerequisites:
#   - Full Disk Access granted to your Terminal in
#     System Settings → Privacy & Security → Full Disk Access
#   - "Share Across Devices" enabled in Settings → Screen Time on both
#     this Mac and your iPhone (otherwise iOS data won't be in the DB)
#
# This script:
#   1. Copies the live RemoteManagement.sqlite + WAL/shm to a temp dir
#      (the live DB is in WAL mode while macOS writes to it).
#   2. Dumps the schema and lists tables that look related to usage.
#   3. Shows a few sample rows from the most likely candidate tables.
#   4. Cleans up the temp copy.
#
# Run:
#   bash scripts/screentime-discover.sh > /tmp/screentime-schema.txt 2>&1
#   pbcopy < /tmp/screentime-schema.txt   # then paste back to Claude
#
# No data leaves this machine unless you explicitly share the output.

set -u
set -o pipefail

DB_DIR="$HOME/Library/Application Support/com.apple.RemoteManagementAgent/Database"
DB_NAME="RemoteManagement.sqlite"
TMP_DIR="$(mktemp -d -t screentime-discover.XXXXXX)"
TRAP_FILES=("$TMP_DIR")

cleanup() {
  for f in "${TRAP_FILES[@]}"; do
    [ -e "$f" ] && rm -rf "$f"
  done
}
trap cleanup EXIT

if [ ! -f "$DB_DIR/$DB_NAME" ]; then
  echo "ERROR: Did not find $DB_DIR/$DB_NAME"
  echo "Is Screen Time enabled on this Mac (System Settings → Screen Time)?"
  exit 1
fi

# Copy DB + WAL + shm so we get a consistent snapshot.
cp "$DB_DIR/$DB_NAME" "$TMP_DIR/$DB_NAME" 2>/tmp/cp.err
cp_status=$?
if [ $cp_status -ne 0 ]; then
  echo "ERROR: failed to copy DB ($cp_status)"
  cat /tmp/cp.err 2>/dev/null
  echo
  echo "Most likely cause: Terminal does not have Full Disk Access."
  echo "Fix: System Settings → Privacy & Security → Full Disk Access → toggle Terminal on, then re-run."
  exit 2
fi
[ -f "$DB_DIR/$DB_NAME-wal" ] && cp "$DB_DIR/$DB_NAME-wal" "$TMP_DIR/" 2>/dev/null
[ -f "$DB_DIR/$DB_NAME-shm" ] && cp "$DB_DIR/$DB_NAME-shm" "$TMP_DIR/" 2>/dev/null

DB="$TMP_DIR/$DB_NAME"

echo "==== sqlite3 version ===="
sqlite3 -version
echo

echo "==== File size ===="
ls -lh "$DB" | awk '{print $5, $9}'
echo

echo "==== All tables ===="
sqlite3 "$DB" ".tables"
echo

echo "==== Schema (full) ===="
sqlite3 "$DB" ".schema"
echo

echo "==== Tables matching usage / app / screen / activity ===="
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%usage%' OR name LIKE '%app%' OR name LIKE '%screen%' OR name LIKE '%activity%' OR name LIKE '%category%' OR name LIKE '%bundle%');"
echo

# For each candidate table, show row count + 3 sample rows.
for tbl in $(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%usage%' OR name LIKE '%app%' OR name LIKE '%screen%' OR name LIKE '%activity%' OR name LIKE '%category%' OR name LIKE '%bundle%');"); do
  echo "==== $tbl: row count + 3 sample rows ===="
  sqlite3 "$DB" "SELECT COUNT(*) AS rows FROM \"$tbl\";"
  sqlite3 -header -column "$DB" "SELECT * FROM \"$tbl\" ORDER BY rowid DESC LIMIT 3;" 2>/dev/null
  echo
done

echo "Discovery complete. Output above tells us how to write the real query."
