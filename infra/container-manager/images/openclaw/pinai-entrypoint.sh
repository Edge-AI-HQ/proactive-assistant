#!/bin/sh
set -e

WS="/app/.openclaw/workspace"
READY_MARKER="$WS/.pinai-workspace-ready"
ERROR_MARKER="$WS/.pinai-workspace-error"
STATUS_PORT="${PINAI_WORKSPACE_STATUS_PORT:-8790}"
EXEC_APPROVALS_MODE="${PINAI_OPENCLAW_EXEC_APPROVALS_MODE:-full}"

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

setup_exec_approvals() {
  [ "$EXEC_APPROVALS_MODE" = "off" ] && return 0

  mkdir -p /app/.openclaw /root/.openclaw

  node - <<'EOF'
const fs = require("fs");
const path = require("path");

const appPath = "/app/.openclaw/exec-approvals.json";
const rootPath = "/root/.openclaw/exec-approvals.json";
const socketPath = "/root/.openclaw/exec-approvals.sock";

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const base = readJson(appPath);
const root = readJson(rootPath);
const merged = {
  ...(root && typeof root === "object" ? root : {}),
  ...(base && typeof base === "object" ? base : {}),
  version: 1,
  socket:
    (base && typeof base.socket === "object" && base.socket) ||
    (root && typeof root.socket === "object" && root.socket) || {
      path: socketPath,
    },
  defaults: {
    ...((root && typeof root.defaults === "object" && root.defaults) || {}),
    ...((base && typeof base.defaults === "object" && base.defaults) || {}),
    security: "full",
    ask: "off",
    askFallback: "full",
    autoAllowSkills: true,
  },
};

fs.mkdirSync(path.dirname(appPath), { recursive: true });
fs.writeFileSync(appPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });

try {
  if (fs.existsSync(rootPath) || fs.lstatSync(path.dirname(rootPath)).isDirectory()) {
    try { fs.rmSync(rootPath, { force: true }); } catch {}
    fs.symlinkSync(appPath, rootPath);
  }
} catch {
  fs.copyFileSync(appPath, rootPath);
  fs.chmodSync(rootPath, 0o600);
}
EOF
}

setup_cache() {
  mkdir -p /app/cache/jiti /app/cache/node-compile-cache
  [ "$(ls -A /app/cache/jiti 2>/dev/null)" ] || cp -r /opt/pinai/jiti-warmup/. /app/cache/jiti/ 2>/dev/null || true
  [ "$(ls -A /app/cache/node-compile-cache 2>/dev/null)" ] || cp -r /opt/pinai/node-compile-warmup/. /app/cache/node-compile-cache/ 2>/dev/null || true
  ln -sfn /app/cache/jiti /tmp/jiti
  export NODE_COMPILE_CACHE=/app/cache/node-compile-cache
}

start_workspace_status_server() {
  node -e '
const fs=require("fs");
const http=require("http");
const port=Number(process.env.PINAI_WORKSPACE_STATUS_PORT||8790);
const ready=process.env.PINAI_WORKSPACE_READY_MARKER||"/app/.openclaw/workspace/.pinai-workspace-ready";
const error=process.env.PINAI_WORKSPACE_ERROR_MARKER||"/app/.openclaw/workspace/.pinai-workspace-error";
const path="/pinai/workspace-ready";
const server=http.createServer((req,res)=>{
  if(req.url!==path){res.statusCode=404;res.end("not found");return;}
  if(fs.existsSync(ready)){res.statusCode=200;res.end("ready");return;}
  if(fs.existsSync(error)){res.statusCode=503;res.end("error");return;}
  res.statusCode=503;res.end("pending");
});
server.listen(port,"0.0.0.0",()=>console.log(`[workspace-status] listening on 0.0.0.0:${port}`));
' >/tmp/workspace-status.log 2>&1 &
}

workspace_inject() {
  rm -f "$READY_MARKER" "$ERROR_MARKER"

  if [ -f "$WS/TOOLS.md" ]; then
    echo "[workspace] hot volume detected" >&2
  else
    echo "[workspace] cold volume, waiting for workspace init..." >&2
    for _i in $(seq 1 60); do
      [ -f "$WS/TOOLS.md" ] && break
      sleep 1
    done

    if [ ! -f "$WS/TOOLS.md" ]; then
      echo "[workspace] ERROR: workspace not initialized after 60s" >&2
      mkdir -p "$WS"
      printf 'workspace init timeout at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ERROR_MARKER"
      return 0
    fi
    echo "[workspace] workspace initialized" >&2
  fi

  if [ -n "${PINAI_ONBOARDING_PROFILE_B64:-}" ]; then
    printf "%s" "$PINAI_ONBOARDING_PROFILE_B64" | base64 -d > "$WS/USER.md"
    rm -f "$WS/user.md"
  else
    rm -f "$WS/USER.md" "$WS/user.md"
  fi

  if [ -f "${PINAI_TOOLS_APPEND_PATH:-}" ] && [ -f "$WS/TOOLS.md" ]; then
    grep -qF 'API Endpoint Proxy' "$WS/TOOLS.md" || cat "$PINAI_TOOLS_APPEND_PATH" >> "$WS/TOOLS.md"
  fi

  touch "$WS/AGENTS.md"
  grep -q "PINAI_REMINDER_POLICY_V1" "$WS/AGENTS.md" || \
    printf '\n# PINAI_REMINDER_POLICY_V1\n- For time-based reminders and scheduled follow-ups, ALWAYS use the cron tool (cron.add / cron.update / cron.run).\n- NEVER use exec/process with sleep, while, timeout, or background shell jobs to simulate timers.\n- For Telegram reminders, always send back to the same channel/account context where the user asked.\n' >> "$WS/AGENTS.md"

  rm -f "$ERROR_MARKER"
  touch "$READY_MARKER"
  echo "[workspace] done" >&2
}

_ipv6_proxy() {
  # Usage: _ipv6_proxy <label> <port>
  # Bridges [::]:port -> 127.0.0.1:port so Fly Proxy (IPv6) can reach IPv4-only listeners.
  local label="$1" port="$2"
  node -e "
const net=require('net'),port=${port},label='${label}';
const srv=net.createServer(i=>{const o=net.connect({host:'127.0.0.1',port});i.pipe(o);o.pipe(i);const c=()=>{i.destroy();o.destroy()};i.on('error',c);o.on('error',c)});
srv.on('error',e=>{console.error('['+label+'] fatal',e);process.exit(1)});
srv.listen({host:'::',port,ipv6Only:true},()=>console.log('['+label+'] [::]:'+port+' -> 127.0.0.1:'+port));
" >"/tmp/${label}.log" 2>&1 &
}

start_ipv6_proxies() {
  [ "${PINAI_FLY_MODE:-}" = "1" ] || return 0

  _ipv6_proxy fly-ipv6-proxy           "${OPENCLAW_GATEWAY_PORT:-18789}"
  _ipv6_proxy fly-tg-webhook           "${OPENCLAW_TELEGRAM_WEBHOOK_PORT:-8787}"
  _ipv6_proxy fly-tg-private-webhook   "${OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT:-8788}"
  _ipv6_proxy fly-workspace-status     "${PINAI_WORKSPACE_STATUS_PORT:-8790}"

  sleep 0.2
}

setup_secrets
setup_exec_approvals
setup_cache
start_workspace_status_server
start_ipv6_proxies

export PINAI_WORKSPACE_READY_MARKER="$READY_MARKER"
export PINAI_WORKSPACE_ERROR_MARKER="$ERROR_MARKER"

disable_device_identity() {
  # Remove device identity to bypass pairing requirement
  # When GatewayClient can't load device identity, it falls back to token-only auth
  # Combined with gateway.controlUi.dangerouslyDisableDeviceAuth: true,
  # this allows cron and other internal calls to work without pairing
  rm -f /app/.openclaw/device-identity.* /root/.openclaw/device-identity.* 2>/dev/null || true
  echo "[device-identity] Removed device identity files to bypass pairing" >&2
}

BIND="${PINAI_GATEWAY_BIND:-lan}"
disable_device_identity
openclaw gateway --bind "$BIND" &
OC_PID=$!

trap 'kill $OC_PID 2>/dev/null; wait $OC_PID 2>/dev/null' TERM INT

workspace_inject &

wait $OC_PID
