#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# PinAI OpenClaw container entrypoint
#
# Orchestrates container startup:
#   1. Decode secrets (openclaw config, google credentials)
#   2. Configure exec-approvals for headless mode
#   3. Restore jiti / node compile caches from build-time warmup
#   4. Start IPv6→IPv4 bridges (Fly only)
#   5. Launch OpenClaw gateway
#
# All prompt injection (system guidance, onboarding profile) is handled by
# the platform-hooks plugin via before_prompt_build hook — no file mutation.
#
# Node.js helper scripts live in /opt/pinai/scripts/ to keep this file
# focused on shell orchestration.
# ---------------------------------------------------------------------------

SCRIPTS_DIR="/opt/pinai/scripts"
EXEC_APPROVALS_MODE="${PINAI_OPENCLAW_EXEC_APPROVALS_MODE:-full}"

# ── 1. Secrets ─────────────────────────────────────────────────────────────

setup_secrets() {
  mkdir -p /app/.openclaw /app/google /root/.config/gws

  if [ -n "${OPENCLAW_CONFIG_B64:-}" ]; then
    printf "%s" "$OPENCLAW_CONFIG_B64" | base64 -d > /app/.openclaw/openclaw.json
  fi

  GWS_CREDS="/app/google/gws-credentials.json"
  GWS_DEFAULT="/root/.config/gws/credentials.json"
  if [ -n "${PINAI_GOOGLE_CREDENTIALS_B64:-}" ]; then
    printf "%s" "$PINAI_GOOGLE_CREDENTIALS_B64" | base64 -d > "$GWS_CREDS"
    cp "$GWS_CREDS" "$GWS_DEFAULT"
  else
    rm -f "$GWS_CREDS" "$GWS_DEFAULT"
  fi
}

# ── 2. Exec approvals ─────────────────────────────────────────────────────

setup_exec_approvals() {
  [ "$EXEC_APPROVALS_MODE" = "off" ] && return 0
  mkdir -p /app/.openclaw /root/.openclaw
  node "$SCRIPTS_DIR/setup-exec-approvals.js"
}

# ── 3. Cache restoration ──────────────────────────────────────────────────

setup_cache() {
  mkdir -p /app/cache/jiti /app/cache/node-compile-cache
  [ "$(ls -A /app/cache/jiti 2>/dev/null)" ] || cp -r /opt/pinai/jiti-warmup/. /app/cache/jiti/ 2>/dev/null || true
  [ "$(ls -A /app/cache/node-compile-cache 2>/dev/null)" ] || cp -r /opt/pinai/node-compile-warmup/. /app/cache/node-compile-cache/ 2>/dev/null || true
  ln -sfn /app/cache/jiti /tmp/jiti
  export NODE_COMPILE_CACHE=/app/cache/node-compile-cache
}

# ── 4. IPv6 proxies (Fly only) ────────────────────────────────────────────

start_ipv6_proxies() {
  [ "${PINAI_FLY_MODE:-}" = "1" ] || return 0

  node "$SCRIPTS_DIR/ipv6-proxy.js" fly-ipv6-proxy         "${OPENCLAW_GATEWAY_PORT:-18789}"      >"/tmp/fly-ipv6-proxy.log" 2>&1 &
  node "$SCRIPTS_DIR/ipv6-proxy.js" fly-tg-webhook         "${OPENCLAW_TELEGRAM_WEBHOOK_PORT:-8787}" >"/tmp/fly-tg-webhook.log" 2>&1 &
  node "$SCRIPTS_DIR/ipv6-proxy.js" fly-tg-private-webhook "${OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT:-8788}" >"/tmp/fly-tg-private-webhook.log" 2>&1 &

  sleep 0.2
}

# ── Main ──────────────────────────────────────────────────────────────────

setup_secrets
setup_exec_approvals
setup_cache

start_ipv6_proxies

BIND="${PINAI_GATEWAY_BIND:-lan}"
exec openclaw gateway --bind "$BIND"
