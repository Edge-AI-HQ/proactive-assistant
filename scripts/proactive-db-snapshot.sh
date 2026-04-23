#!/bin/bash

set -euo pipefail

WATCH=0
ONCE=0
INTERVAL_SECONDS="${INTERVAL_SECONDS:-3}"
OUT_DIR="${SNAPSHOT_OUT_DIR:-/tmp/pin-proactive}"
SRC_DIR="${SRC_DIR:-}"
CONTAINER_NAME="${PROACTIVE_CONTAINER:-}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/proactive-db-snapshot.sh [options]

Options:
  --src-dir <dir>       Source directory that contains proactive.db and mobile_items.db.
  --out-dir <dir>       Output directory for snapshot DBs. Default: /tmp/pin-proactive
  --container <name>    Running proactive container name. Default: first container matching ^proactive-
  --interval <seconds>  Refresh interval in watch mode. Default: 3
  --once                Run one snapshot pass and exit.
  --watch               Keep refreshing snapshots in a loop.
  -h, --help            Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src-dir)
      SRC_DIR="${2:?missing value for --src-dir}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?missing value for --out-dir}"
      shift 2
      ;;
    --container)
      CONTAINER_NAME="${2:?missing value for --container}"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="${2:?missing value for --interval}"
      shift 2
      ;;
    --once)
      ONCE=1
      shift
      ;;
    --watch)
      WATCH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$WATCH" -eq 1 && "$ONCE" -eq 1 ]]; then
  echo "--once and --watch cannot be used together" >&2
  exit 1
fi

if [[ "$WATCH" -eq 0 && "$ONCE" -eq 0 ]]; then
  ONCE=1
fi

resolve_src_dir() {
  if [[ -n "$SRC_DIR" ]]; then
    echo "$SRC_DIR"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required when --src-dir is not provided" >&2
    return 1
  fi

  local container_name="$CONTAINER_NAME"
  if [[ -z "$container_name" ]]; then
    container_name="$(docker ps --format '{{.Names}}' | awk '/^proactive-/{print; exit}')"
  fi

  if [[ -z "$container_name" ]]; then
    echo "Could not find a running container matching ^proactive-" >&2
    return 1
  fi

  local mount_source
  mount_source="$(docker inspect "$container_name" --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}')"

  if [[ -z "$mount_source" ]]; then
    echo "Could not resolve /app bind mount for container: $container_name" >&2
    return 1
  fi

  echo "$mount_source/data"
}

snapshot_db() {
  local src_db="$1"
  local dst_db="$2"
  local tmp_db="${dst_db}.tmp.$$"

  rm -f "$tmp_db"
  sqlite3 "$src_db" ".timeout 5000" ".backup '$tmp_db'"
  sqlite3 "$tmp_db" "PRAGMA journal_mode=DELETE;" >/dev/null
  mv -f "$tmp_db" "$dst_db"
}

snapshot_all() {
  local source_dir="$1"
  local proactive_src="$source_dir/proactive.db"
  local mobile_src="$source_dir/mobile_items.db"
  local proactive_dst="$OUT_DIR/proactive.snapshot.db"
  local mobile_dst="$OUT_DIR/mobile_items.snapshot.db"

  if [[ ! -f "$proactive_src" ]]; then
    echo "Missing source DB: $proactive_src" >&2
    return 1
  fi
  if [[ ! -f "$mobile_src" ]]; then
    echo "Missing source DB: $mobile_src" >&2
    return 1
  fi

  mkdir -p "$OUT_DIR"

  snapshot_db "$proactive_src" "$proactive_dst"
  snapshot_db "$mobile_src" "$mobile_dst"

  echo "[$(date '+%F %T')] snapshot refreshed"
  echo "  source: $source_dir"
  echo "  proactive: $proactive_dst"
  echo "  mobile_items: $mobile_dst"
}

MAIN_SRC_DIR="$(resolve_src_dir)"

if [[ "$WATCH" -eq 1 ]]; then
  while true; do
    snapshot_all "$MAIN_SRC_DIR"
    sleep "$INTERVAL_SECONDS"
  done
fi

snapshot_all "$MAIN_SRC_DIR"
