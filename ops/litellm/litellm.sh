#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage: ops/litellm/litellm.sh <command>

Commands:
  up                Start LiteLLM container
  restart           Recreate and restart LiteLLM container
  logs              Tail LiteLLM logs
  cleanup-local-db  Remove legacy local LiteLLM DB container if present
  verify-db-env     Show LiteLLM DB env var from running container
EOF
}

run_compose() {
  (cd "$ROOT_DIR" && docker compose "$@")
}

case "${1:-}" in
  up)
    run_compose up -d litellm
    ;;
  restart)
    run_compose up -d --force-recreate litellm
    ;;
  logs)
    run_compose logs -f --tail=120 litellm
    ;;
  cleanup-local-db)
    docker rm -f pin-ai-litellm-db >/dev/null 2>&1 || true
    ;;
  verify-db-env)
    docker inspect pin-ai-litellm --format '{{range .Config.Env}}{{println .}}{{end}}' | rg '^LITELLM_DB_URL='
    ;;
  *)
    usage
    exit 1
    ;;
esac
