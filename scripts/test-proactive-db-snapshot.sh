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
  "INSERT INTO profile (id, display_name) VALUES ('local', 'Pin');"

sqlite3 "$SRC_DIR/mobile_items.db" \
  "CREATE TABLE mobile_items (id TEXT PRIMARY KEY, title TEXT NOT NULL);" \
  "INSERT INTO mobile_items (id, title) VALUES ('item-1', 'Focus');"

"$SCRIPT" --src-dir "$SRC_DIR" --out-dir "$OUT_DIR" --once

test -f "$OUT_DIR/proactive.snapshot.db"
test -f "$OUT_DIR/mobile_items.snapshot.db"

profile_name="$(sqlite3 "$OUT_DIR/proactive.snapshot.db" "SELECT display_name FROM profile WHERE id = 'local';")"
item_title="$(sqlite3 "$OUT_DIR/mobile_items.snapshot.db" "SELECT title FROM mobile_items WHERE id = 'item-1';")"
proactive_journal_mode="$(sqlite3 "$OUT_DIR/proactive.snapshot.db" "PRAGMA journal_mode;")"
mobile_journal_mode="$(sqlite3 "$OUT_DIR/mobile_items.snapshot.db" "PRAGMA journal_mode;")"

test "$profile_name" = "Pin"
test "$item_title" = "Focus"
test "$proactive_journal_mode" = "delete"
test "$mobile_journal_mode" = "delete"

echo "snapshot test passed"
