#!/bin/sh
set -e

# ─── PIN AI OpenClaw Entrypoint ───
# Unified entrypoint for both Docker and Fly.io.
# OPENCLAW_HOME=/app makes OpenClaw write all state to /app/.openclaw/.
# Volume/bind-mount at /app persists everything — no symlinks needed.
#
# Fly-specific behaviour (IPv6 proxies, loopback bind) is activated by
# setting PINAI_FLY_MODE=1 and PINAI_GATEWAY_BIND=loopback.

WS="/app/.openclaw/workspace"

# ── 1. Decode runtime secrets from env vars ──────────────────────────
setup_secrets() {
  # Only create .openclaw/ for config — do NOT create workspace/ here.
  # OpenClaw skips workspace init if the directory already exists.
  mkdir -p /app/.openclaw /app/google /root/.config/gws

  # OpenClaw config JSON → default config path for OPENCLAW_HOME=/app
  if [ -n "${OPENCLAW_CONFIG_B64:-}" ]; then
    printf "%s" "$OPENCLAW_CONFIG_B64" | base64 -d > /app/.openclaw/openclaw.json
  fi

  # Onboarding profile → USER.md: deferred to workspace_inject() after workspace exists.

  # Google Workspace CLI credentials
  GWS_CREDS="/app/google/gws-credentials.json"
  GWS_DEFAULT="/root/.config/gws/credentials.json"
  if [ -n "${PINAI_GOOGLE_CREDENTIALS_B64:-}" ]; then
    printf "%s" "$PINAI_GOOGLE_CREDENTIALS_B64" | base64 -d > "$GWS_CREDS"
    cp "$GWS_CREDS" "$GWS_DEFAULT"
  else
    rm -f "$GWS_CREDS" "$GWS_DEFAULT"
  fi
}

# ── 2. Seed jiti + Node compile caches ───────────────────────────────
setup_cache() {
  mkdir -p /app/cache/jiti /app/cache/node-compile-cache

  # Cold volume: seed from image-baked warmup layer
  [ "$(ls -A /app/cache/jiti 2>/dev/null)" ] || \
    cp -r /opt/pinai/jiti-warmup/. /app/cache/jiti/ 2>/dev/null || true
  [ "$(ls -A /app/cache/node-compile-cache 2>/dev/null)" ] || \
    cp -r /opt/pinai/node-compile-warmup/. /app/cache/node-compile-cache/ 2>/dev/null || true

  ln -sfn /app/cache/jiti /tmp/jiti
  export NODE_COMPILE_CACHE=/app/cache/node-compile-cache
}

# ── 3. Workspace content injection (runs AFTER openclaw creates workspace) ──
workspace_inject() {
  # Hot path: workspace already exists (volume has data from previous run)
  if [ -f "$WS/TOOLS.md" ]; then
    echo "[workspace] hot volume detected" >&2
  else
    # Cold path: wait for openclaw to initialize workspace
    echo "[workspace] cold volume, waiting for workspace init..." >&2
    for _i in $(seq 1 60); do
      [ -f "$WS/TOOLS.md" ] && break
      sleep 1
    done

    if [ ! -f "$WS/TOOLS.md" ]; then
      echo "[workspace] FATAL: workspace not initialized after 60s" >&2
      kill $OC_PID 2>/dev/null || true
      return 1
    fi
    echo "[workspace] workspace initialized" >&2
  fi

  # Inject USER.md (idempotent)
  if [ -n "${PINAI_ONBOARDING_PROFILE_B64:-}" ]; then
    printf "%s" "$PINAI_ONBOARDING_PROFILE_B64" | base64 -d > "$WS/USER.md"
    rm -f "$WS/user.md"
  else
    rm -f "$WS/USER.md" "$WS/user.md"
  fi

  # Append custom TOOLS.md content (idempotent)
  if [ -f "${PINAI_TOOLS_APPEND_PATH:-}" ] && [ -f "$WS/TOOLS.md" ]; then
    grep -qF 'API Endpoint Proxy' "$WS/TOOLS.md" || \
      cat "$PINAI_TOOLS_APPEND_PATH" >> "$WS/TOOLS.md"
  fi

  # Append reminder policy to AGENTS.md (idempotent)
  touch "$WS/AGENTS.md"
  grep -q "PINAI_REMINDER_POLICY_V1" "$WS/AGENTS.md" || \
    printf '\n# PINAI_REMINDER_POLICY_V1\n- For time-based reminders and scheduled follow-ups, ALWAYS use the cron tool (cron.add / cron.update / cron.run).\n- NEVER use exec/process with sleep, while, timeout, or background shell jobs to simulate timers.\n- For Telegram reminders, always send back to the same channel/account context where the user asked.\n' >> "$WS/AGENTS.md"

  echo "[workspace] done" >&2
}

# ── 4. IPv6 TCP proxies (Fly only) ──────────────────────────────────
# Fly machines bind openclaw to 127.0.0.1 (loopback) but Fly's proxy
# connects via IPv6. These lightweight Node TCP proxies bridge [::] → 127.0.0.1.
start_ipv6_proxies() {
  [ "${PINAI_FLY_MODE:-}" = "1" ] || return 0

  # Gateway proxy
  GW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
  node -e "
const net=require('net');const port=${GW_PORT};
const srv=net.createServer(i=>{const o=net.connect({host:'127.0.0.1',port});i.pipe(o);o.pipe(i);const c=()=>{i.destroy();o.destroy()};i.on('error',c);o.on('error',c)});
srv.on('error',e=>{console.error('[fly-ipv6-proxy] fatal',e);process.exit(1)});
srv.listen({host:'::',port,ipv6Only:true},()=>console.log('[fly-ipv6-proxy] [::]:'+port+' -> 127.0.0.1:'+port));
" >/tmp/fly-ipv6-proxy.log 2>&1 &

  # Telegram webhook proxy
  WH_PORT="${OPENCLAW_TELEGRAM_WEBHOOK_PORT:-8787}"
  node -e "
const net=require('net');const port=${WH_PORT};
const srv=net.createServer(i=>{const o=net.connect({host:'127.0.0.1',port});i.pipe(o);o.pipe(i);const c=()=>{i.destroy();o.destroy()};i.on('error',c);o.on('error',c)});
srv.on('error',e=>{console.error('[fly-tg-webhook-ipv6-proxy] fatal',e);process.exit(1)});
srv.listen({host:'::',port,ipv6Only:true},()=>console.log('[fly-tg-webhook-ipv6-proxy] [::]:'+port+' -> 127.0.0.1:'+port));
" >/tmp/fly-tg-webhook-ipv6-proxy.log 2>&1 &

  # Telegram private webhook proxy
  PWH_PORT="${OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT:-8788}"
  node -e "
const net=require('net');const port=${PWH_PORT};
const srv=net.createServer(i=>{const o=net.connect({host:'127.0.0.1',port});i.pipe(o);o.pipe(i);const c=()=>{i.destroy();o.destroy()};i.on('error',c);o.on('error',c)});
srv.on('error',e=>{console.error('[fly-tg-private-webhook-ipv6-proxy] fatal',e);process.exit(1)});
srv.listen({host:'::',port,ipv6Only:true},()=>console.log('[fly-tg-private-webhook-ipv6-proxy] [::]:'+port+' -> 127.0.0.1:'+port));
" >/tmp/fly-tg-private-webhook-ipv6-proxy.log 2>&1 &

  sleep 0.2
}

# ── Main ─────────────────────────────────────────────────────────────
setup_secrets
setup_cache
start_ipv6_proxies

BIND="${PINAI_GATEWAY_BIND:-lan}"
openclaw gateway --bind "$BIND" &
OC_PID=$!

# Forward SIGTERM/SIGINT to openclaw for graceful shutdown
trap 'kill $OC_PID 2>/dev/null; wait $OC_PID 2>/dev/null' TERM INT

workspace_inject &

wait $OC_PID
