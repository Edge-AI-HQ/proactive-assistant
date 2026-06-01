#!/usr/bin/env bash
# ngrok_url.sh — print this worktree group's public ngrok URL.
#
# The ngrok agent (compose service "ngrok", profile=tunnel) binds this
# worktree's stable .ngrok.app subdomain (--url in docker-compose.yml), but the
# host port of its :4040 local API is random per group. We read
# it from ngrok's local API on port 4040. Used by `make tunnel-up` (to inject
# PAI_API_URL into the chat container) and `make ios` (to bake the URL into the
# native bundle).
#
# Prints the https URL to stdout on success; exits non-zero with a clear
# message on stderr if the tunnel isn't up or no URL appears within the timeout.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Match the Makefile's per-worktree project name so docker compose targets THIS
# group's ngrok container (also works standalone, not only when run from make).
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pinai-$(git rev-parse --show-toplevel | shasum | cut -c1-8)}"

TIMEOUT="${NGROK_URL_TIMEOUT:-30}"

# Host port that ngrok's :4040 local API is mapped to (random per group).
api_addr="$(docker compose port ngrok 4040 2>/dev/null || true)"
if [ -z "$api_addr" ]; then
  echo "ngrok tunnel is not running for project $COMPOSE_PROJECT_NAME." >&2
  echo "  Start it with: make tunnel-up   (make ios/android start it automatically)." >&2
  exit 1
fi
api_port="${api_addr##*:}"

deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  url="$(curl -fsS "http://localhost:${api_port}/api/tunnels" 2>/dev/null \
    | python3 -c 'import sys, json
try:
    tunnels = json.load(sys.stdin).get("tunnels", [])
except Exception:
    sys.exit(0)
for t in tunnels:
    u = t.get("public_url", "")
    if u.startswith("https://"):
        print(u)
        break' 2>/dev/null || true)"
  if [ -n "$url" ]; then
    echo "$url"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ngrok did not report a public URL within ${TIMEOUT}s (project $COMPOSE_PROJECT_NAME)." >&2
    echo "  Check: docker compose logs ngrok   — is NGROK_AUTHTOKEN valid / not rate-limited?" >&2
    exit 1
  fi
  sleep 1
done
