#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEVICE=""
BUNDLE_ID=""
OUT_DIR="$PROJECT_ROOT/ambient-db-dumps/current"
OPEN_NAVICAT_DIR=0

usage() {
  cat <<'USAGE'
Export Ambient SQLite databases from an iOS device app container.

Usage:
  bash scripts/export-ambient-sqlite.sh [options]

Options:
  --device <id|name|udid>     Device identifier. If omitted and exactly one paired
                              device is known to Xcode, the script uses it.
  --bundle-id <bundle id>     App bundle id. If omitted, tries:
                              ai.pin.proactive.dev, ai.pin.proactive,
                              com.pinai.proactive-ai.dev.
  --out <dir>                 Output directory. Default: ./ambient-db-dumps/current.
                              The directory is reused and overwritten each run.
  --open                      Open the exported DB folder in Finder.
  -h, --help                  Show this help.

Examples:
  bash scripts/export-ambient-sqlite.sh
  bash scripts/export-ambient-sqlite.sh --bundle-id ai.pin.proactive.dev
  bash scripts/export-ambient-sqlite.sh --device A3E73438-BF26-5544-B8EB-F93E76D21F77
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --bundle-id)
      BUNDLE_ID="${2:-}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --open)
      OPEN_NAVICAT_DIR=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd xcrun
need_cmd python3

resolve_device() {
  if [[ -n "$DEVICE" ]]; then
    printf '%s\n' "$DEVICE"
    return
  fi

  local json
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" --quiet >/dev/null
  python3 - "$json" <<'PY'
import json
import sys

path = sys.argv[1]
devices = json.load(open(path)).get("result", {}).get("devices", [])
paired = []
connected = []
for device in devices:
    cp = device.get("connectionProperties") or {}
    if cp.get("pairingState") == "paired":
        paired.append(device)
        if cp.get("tunnelState") == "connected":
            connected.append(device)

choices = connected if len(connected) == 1 else paired
if len(choices) == 1:
    print(choices[0].get("identifier"))
elif len(paired) == 0:
    print("No paired iOS device found. Connect/unlock the phone, trust this Mac, then rerun.", file=sys.stderr)
    raise SystemExit(2)
else:
    print("Multiple paired devices found; pass --device explicitly:", file=sys.stderr)
    for item in paired:
        cp = item.get("connectionProperties") or {}
        print(
            f"  {item.get('identifier')} "
            f"(tunnelState={cp.get('tunnelState')}, transport={cp.get('transportType')})",
            file=sys.stderr,
        )
    raise SystemExit(2)
PY
  rm -f "$json"
}

resolve_bundle_id() {
  if [[ -n "$BUNDLE_ID" ]]; then
    printf '%s\n' "$BUNDLE_ID"
    return
  fi

  local json
  json="$(mktemp)"
  xcrun devicectl device info apps \
    --device "$DEVICE" \
    --json-output "$json" \
    --quiet >/dev/null
  python3 - "$json" <<'PY'
import json
import sys

preferred = [
    "ai.pin.proactive.dev",
    "ai.pin.proactive",
    "com.pinai.proactive-ai.dev",
]
apps = json.load(open(sys.argv[1])).get("result", {}).get("apps", [])
installed = {app.get("bundleIdentifier"): app for app in apps}
for bundle_id in preferred:
    if bundle_id in installed:
        print(bundle_id)
        raise SystemExit(0)
print("PIN AI app bundle not found. Installed developer apps:", file=sys.stderr)
for bundle_id in sorted(k for k in installed if k):
    print(f"  {bundle_id}", file=sys.stderr)
print("Pass --bundle-id explicitly.", file=sys.stderr)
raise SystemExit(2)
PY
  rm -f "$json"
}

copy_source() {
  local source="$1"
  local dest="$2"
  local optional="${3:-0}"
  mkdir -p "$dest"
  echo "==> Copying app container source: $source"
  if xcrun devicectl device copy from \
      --device "$DEVICE" \
      --domain-type appDataContainer \
      --domain-identifier "$BUNDLE_ID" \
      --source "$source" \
      --destination "$dest" \
      --quiet >/dev/null; then
    echo "    copied: $source"
  else
    if [[ "$optional" == "1" ]]; then
      echo "    optional source missing: $source"
    else
      echo "    skipped: $source not available or not readable"
    fi
  fi
}

make_snapshot() {
  local db_path="$1"
  local snapshot_dir="$2"
  local base clean
  base="$(basename "$db_path")"
  clean="${base/SQLite.db/.db}"
  mkdir -p "$snapshot_dir"

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db_path" ".backup '$snapshot_dir/$clean'"
  else
    cp "$db_path" "$snapshot_dir/$clean"
  fi
  printf '%s\n' "$snapshot_dir/$clean"
}

write_inspect_sql() {
  local output_dir="$1"
  cat > "$output_dir/ambient-timeline-inspect.sql" <<'SQL'
SELECT id, local_date, source_type, event_type, occurred_at, compact_text
FROM ambient_raw_events
ORDER BY occurred_at DESC
LIMIT 50;

SELECT id, local_date, window_type, status, started_at, compact_context
FROM ambient_candidate_windows
ORDER BY started_at DESC
LIMIT 50;

SELECT id, local_date, generation_status, sync_status, occurred_at, title, summary, privacy, confidence_label
FROM ambient_timeline_events
ORDER BY occurred_at DESC
LIMIT 50;
SQL
}

if ! DEVICE="$(resolve_device)"; then
  exit $?
fi
if [[ -z "$DEVICE" ]]; then
  echo "Could not resolve device id." >&2
  exit 2
fi

if ! BUNDLE_ID="$(resolve_bundle_id)"; then
  exit $?
fi
if [[ -z "$BUNDLE_ID" ]]; then
  echo "Could not resolve app bundle id." >&2
  exit 2
fi

EXPORT_DIR="$OUT_DIR"
RAW_DIR="$EXPORT_DIR/app-container"
SNAPSHOT_DIR="$EXPORT_DIR/navicat"

mkdir -p "$EXPORT_DIR"
rm -rf "$RAW_DIR" "$SNAPSHOT_DIR"
rm -f "$EXPORT_DIR/ambient-timeline-inspect.sql"
mkdir -p "$RAW_DIR" "$SNAPSHOT_DIR"

echo "==> Device: $DEVICE"
echo "==> Bundle: $BUNDLE_ID"
echo "==> Output: $EXPORT_DIR"

copy_source "Documents" "$RAW_DIR/Documents"
copy_source "Library/CapacitorDatabase" "$RAW_DIR/Library-CapacitorDatabase" "1"

DBS=()
while IFS= read -r db; do
  DBS+=("$db")
done < <(
  find "$RAW_DIR" -type f \( \
    -name "pin_ambient_timelineSQLite.db" -o \
    -name "pin_ambient_outboxSQLite.db" -o \
    -name "*ambient*SQLite.db" \
  \) | sort
)

if [[ "${#DBS[@]}" -eq 0 ]]; then
  echo ""
  echo "No Ambient SQLite DB found in copied container." >&2
  echo "Open the app once, keep Ambient page visible for a few seconds, then rerun." >&2
  exit 1
fi

echo ""
echo "==> Creating clean Navicat snapshots"
for db in "${DBS[@]}"; do
  snapshot="$(make_snapshot "$db" "$SNAPSHOT_DIR")"
  echo "    $(basename "$snapshot")"
done

write_inspect_sql "$EXPORT_DIR"

echo ""
echo "Done."
echo "Open this folder in Navicat/Finder:"
echo "  $SNAPSHOT_DIR"
echo ""
echo "Useful query file:"
echo "  $EXPORT_DIR/ambient-timeline-inspect.sql"

if [[ "$OPEN_NAVICAT_DIR" -eq 1 ]]; then
  open "$SNAPSHOT_DIR"
fi
