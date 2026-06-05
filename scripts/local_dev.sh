#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

. "$ROOT_DIR/scripts/local_env.sh"

STATE_DIR="$ROOT_DIR/tmp/local-hot"
PIDS_FILE="$STATE_DIR/pids"
TEMP_DOCKER_CONFIG=""
LOCAL_COMPOSE=(docker compose -f "$ROOT_DIR/docker-compose.local.yml")

usage() {
  echo "Usage: $0 [start|stop|status]"
}

prepare_docker_config() {
  if [ -n "${DOCKER_CONFIG:-}" ]; then
    return 0
  fi
  if ! grep -q '"credsStore"' "$HOME/.docker/config.json" 2>/dev/null; then
    return 0
  fi
  TEMP_DOCKER_CONFIG="$(mktemp -d /tmp/pinai-docker-config-no-creds.XXXXXX)"
  printf '{"auths":{}}\n' > "$TEMP_DOCKER_CONFIG/config.json"
  mkdir -p "$TEMP_DOCKER_CONFIG/cli-plugins"
  ln -s "$HOME/.docker/cli-plugins/docker-compose" "$TEMP_DOCKER_CONFIG/cli-plugins/docker-compose"
  ln -s "$HOME/.docker/cli-plugins/docker-buildx" "$TEMP_DOCKER_CONFIG/cli-plugins/docker-buildx"
  export DOCKER_CONFIG="$TEMP_DOCKER_CONFIG"
}

cleanup_temp_docker_config() {
  if [ -n "$TEMP_DOCKER_CONFIG" ]; then
    rm -rf "$TEMP_DOCKER_CONFIG"
  fi
}

ensure_port_free() {
  local port="$1"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: localhost:$port is already in use."
    echo "Stop that process or run: make local-stop"
    exit 1
  fi
}

stop_host_processes() {
  if [ ! -f "$PIDS_FILE" ]; then
    return 0
  fi
  while read -r pid; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < "$PIDS_FILE"
  rm -f "$PIDS_FILE"
}

stop_all() {
  stop_host_processes
  COMPOSE_PROJECT_NAME="$PINAI_LOCAL_COMPOSE_PROJECT" "${LOCAL_COMPOSE[@]}" down
}

status_all() {
  echo "Local Hot mode:"
  echo "  Frontend: $PINAI_LOCAL_FRONTEND_URL"
  echo "  Web API:  $PINAI_LOCAL_WEB_URL"
  echo "  Chat API: $PINAI_LOCAL_CHAT_URL"
  echo "  Auth:     X-Dev-Auth $PINAI_LOCAL_DEV_AUTH_HEADER"
  echo "  DB:       $PINAI_LOCAL_DATABASE_URL"
  echo "  LiteLLM:  $PINAI_LOCAL_LITELLM_BASE_URL"
  echo ""
  if [ -f "$PIDS_FILE" ]; then
    echo "Host processes:"
    while read -r pid; do
      [ -n "$pid" ] || continue
      if kill -0 "$pid" >/dev/null 2>&1; then
        echo "  $pid running"
      else
        echo "  $pid stopped"
      fi
    done < "$PIDS_FILE"
  else
    echo "Host processes: not running"
  fi
  echo ""
  COMPOSE_PROJECT_NAME="$PINAI_LOCAL_COMPOSE_PROJECT" "${LOCAL_COMPOSE[@]}" ps
}

wait_for_url() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 80); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for $label at $url"
  return 1
}

start_dependencies() {
  echo "==> Starting fixed local dependencies"
  COMPOSE_PROJECT_NAME="$PINAI_LOCAL_COMPOSE_PROJECT" "${LOCAL_COMPOSE[@]}" up -d postgres
  COMPOSE_PROJECT_NAME="$PINAI_LOCAL_COMPOSE_PROJECT" "${LOCAL_COMPOSE[@]}" build db-migrate
  COMPOSE_PROJECT_NAME="$PINAI_LOCAL_COMPOSE_PROJECT" "${LOCAL_COMPOSE[@]}" run --rm db-migrate
  (
    cd "$ROOT_DIR/pinai-agents"
    DATABASE_URL="$PINAI_LOCAL_DATABASE_URL" uv run python -m scripts.seed_patterns
  )
  COMPOSE_PROJECT_NAME="$PINAI_LOCAL_COMPOSE_PROJECT" "${LOCAL_COMPOSE[@]}" up -d litellm
  wait_for_url "http://127.0.0.1:4000/health/liveliness" "LiteLLM"
}

start_host_processes() {
  mkdir -p "$STATE_DIR"
  rm -f "$PIDS_FILE"

  ensure_port_free 3000
  ensure_port_free 8000
  ensure_port_free 8001

  echo "==> Starting pinai-web with uvicorn --reload"
  (
    set -a
    . "$ROOT_DIR/pinai-agents/.env"
    set +a
    export DEPLOY_ENV=dev
    export DATABASE_URL="$PINAI_LOCAL_DATABASE_URL"
    export LITELLM_BASE_URL="$PINAI_LOCAL_LITELLM_BASE_URL"
    export CHAT_INTERNAL_URL="$PINAI_LOCAL_CHAT_URL"
    cd "$ROOT_DIR/pinai-agents"
    exec uv run uvicorn pinai_agents.web.asgi:app --reload --host 127.0.0.1 --port 8000
  ) &
  echo "$!" >> "$PIDS_FILE"

  echo "==> Starting pinai-chat with uvicorn --reload"
  (
    set -a
    . "$ROOT_DIR/pinai-agents/.env.chat"
    set +a
    export DEPLOY_ENV=dev
    export DATABASE_URL="$PINAI_LOCAL_DATABASE_URL"
    export LITELLM_BASE_URL="$PINAI_LOCAL_LITELLM_BASE_URL"
    export WEB_INTERNAL_URL="$PINAI_LOCAL_WEB_URL"
    export PAI_API_URL="${PAI_API_URL:-$PINAI_LOCAL_WEB_URL}"
    export PINAI_LOCAL_SANDBOX="${PINAI_LOCAL_SANDBOX:-1}"
    cd "$ROOT_DIR/pinai-agents"
    exec uv run uvicorn pinai_agents.chat.asgi:app --reload --host 127.0.0.1 --port 8001
  ) &
  echo "$!" >> "$PIDS_FILE"

  echo "==> Starting proactive-ai-frontend Vite dev server"
  (
    set -a
    . "$ROOT_DIR/pinai-agents/.env"
    set +a
    export VITE_PIN_LOCAL_DEV_AUTH=1
    export VITE_PIN_API_PROXY_TARGET="$PINAI_LOCAL_WEB_URL"
    cd "$ROOT_DIR/proactive-ai-frontend"
    exec npm run dev -- --host 127.0.0.1 --port 3000
  ) &
  echo "$!" >> "$PIDS_FILE"
}

monitor_processes() {
  echo ""
  status_all
  echo ""
  echo "Press Ctrl-C to stop host hot-reload processes. DB/LiteLLM stay up unless you run make local-stop."
  while true; do
    while read -r pid; do
      [ -n "$pid" ] || continue
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        echo "ERROR: local process $pid exited."
        stop_host_processes
        exit 1
      fi
    done < "$PIDS_FILE"
    sleep 2
  done
}

cmd="${1:-start}"
prepare_docker_config
case "$cmd" in
  start)
    trap 'stop_host_processes; cleanup_temp_docker_config' INT TERM EXIT
    bash "$ROOT_DIR/scripts/decrypt_env.sh" ops/litellm
    bash "$ROOT_DIR/scripts/decrypt_env.sh" pinai-agents
    make --no-print-directory ensure-env-pinai-agents >/dev/null
    start_dependencies
    start_host_processes
    monitor_processes
    ;;
  stop)
    stop_all
    cleanup_temp_docker_config
    ;;
  status)
    status_all
    cleanup_temp_docker_config
    ;;
  *)
    usage
    exit 2
    ;;
esac
