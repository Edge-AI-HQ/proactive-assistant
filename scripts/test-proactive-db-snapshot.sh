#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/proactive-db-snapshot.sh"
TMP_DIR="$(mktemp -d)"
SRC_DIR="$TMP_DIR/src"
OUT_DIR="$TMP_DIR/out"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$SRC_DIR" "$OUT_DIR"

sqlite3 "$SRC_DIR/proactive.db" \
  "CREATE TABLE profile (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);" \
  "CREATE TABLE lost_and_found (id INTEGER);" \
  "CREATE TABLE profile_signals (id TEXT PRIMARY KEY);" \
  "CREATE TABLE profile_interests (id TEXT PRIMARY KEY);" \
  "CREATE TABLE auto_loop_state (id INTEGER PRIMARY KEY);" \
  "CREATE TABLE chat_crystallize_state (id TEXT PRIMARY KEY);" \
  "INSERT INTO profile (id, display_name) VALUES ('local', 'Pin');" \
  "INSERT INTO lost_and_found (id) VALUES (1);" \
  "INSERT INTO profile_signals (id) VALUES ('sig-1');" \
  "INSERT INTO profile_interests (id) VALUES ('interest-1');" \
  "INSERT INTO auto_loop_state (id) VALUES (1);" \
  "INSERT INTO chat_crystallize_state (id) VALUES ('default');"

sqlite3 "$SRC_DIR/raw.db" \
  "CREATE TABLE device_contacts_snapshot (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);" \
  "INSERT INTO device_contacts_snapshot (id, display_name) VALUES ('contact-1', '张三');"

"$SCRIPT" --src-dir "$SRC_DIR" --out-dir "$OUT_DIR" --once

test -f "$OUT_DIR/proactive.snapshot.db"
test -f "$OUT_DIR/raw.snapshot.db"
test ! -f "$OUT_DIR/mobile_items.snapshot.db"

profile_name="$(sqlite3 "$OUT_DIR/proactive.snapshot.db" "SELECT display_name FROM profile WHERE id = 'local';")"
contact_name="$(sqlite3 "$OUT_DIR/raw.snapshot.db" "SELECT display_name FROM device_contacts_snapshot WHERE id = 'contact-1';")"
proactive_journal_mode="$(sqlite3 "$OUT_DIR/proactive.snapshot.db" "PRAGMA journal_mode;")"
raw_journal_mode="$(sqlite3 "$OUT_DIR/raw.snapshot.db" "PRAGMA journal_mode;")"
deprecated_count="$(sqlite3 "$OUT_DIR/proactive.snapshot.db" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('lost_and_found','profile_signals','profile_interests','auto_loop_state','chat_crystallize_state');")"

test "$profile_name" = "Pin"
test "$contact_name" = "张三"
test "$proactive_journal_mode" = "delete"
test "$raw_journal_mode" = "delete"
test "$deprecated_count" = "0"

rm -f "$SRC_DIR/raw.db"
rm -f "$OUT_DIR/raw.snapshot.db"

"$SCRIPT" --src-dir "$SRC_DIR" --out-dir "$OUT_DIR" --once

test ! -f "$OUT_DIR/raw.snapshot.db"

echo "snapshot test passed"
