#!/usr/bin/env bash
# Keep the local-dev Daytona snapshot (pinai-sandbox:local) in sync with the
# sandbox image inputs: backend/packages/pinai_sdk + the builder definition
# (infra/daytona/build_snapshot.py, where the pip pins live).
#
# Called by `make up` / `make restart` (soft-failed there: a Daytona outage
# must not block local boot) and `make daytona-snapshot-local` (FORCE=1).
# A content hash in .daytona-snapshot-local.hash (gitignored, per-worktree)
# skips the ~1min remote rebuild when nothing changed — content hash instead
# of an mtime stamp because git checkouts touch mtimes without changing
# content.
#
# pinai-sandbox:local is org-global while the marker is per-worktree: same
# inputs hash the same everywhere, so parallel worktrees don't fight; if two
# worktrees carry different pinai_sdk edits, the last rebuild wins the shared
# name (fine for one person iterating on the SDK at a time). CI-owned
# pinai-sandbox:{dev,test,production} are never touched here.
set -euo pipefail
cd "$(dirname "$0")/.."

MARKER=".daytona-snapshot-local.hash"

hash_inputs() {
  {
    find backend/packages/pinai_sdk -type f \( -name '*.py' -o -name '*.toml' \) \
      -not -path '*/__pycache__/*'
    echo backend/infra/daytona/build_snapshot.py
  } | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | awk '{print $1}'
}

current="$(hash_inputs)"
if [ "${FORCE:-0}" != "1" ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$current" ]; then
  exit 0 # snapshot inputs unchanged
fi

if [ ! -s backend/.env ]; then
  echo "ensure_daytona_snapshot: backend/.env missing — run 'make ensure-env' first" >&2
  exit 1
fi
api_key="$(set +u; . ./backend/.env >/dev/null 2>&1; printf '%s' "${DAYTONA_API_KEY:-}")"
if [ -z "$api_key" ]; then
  echo "ensure_daytona_snapshot: DAYTONA_API_KEY not found in backend/.env" >&2
  exit 1
fi

echo "→ sandbox inputs changed — rebuilding Daytona snapshot pinai-sandbox:local (~1min)"
(cd backend && DAYTONA_API_KEY="$api_key" uv run python infra/daytona/build_snapshot.py --version local --recreate)
printf '%s\n' "$current" >"$MARKER"
echo "→ pinai-sandbox:local refreshed"
