#!/usr/bin/env bash
# 起 dev-pipeline 服务 + cloudflare quick tunnel（零凭证），打印公网 URL + 下一步命令。
# 用于 M4 真链路联调：拿到 URL 后跑 wire_linear.py 把 Linear 指过来。
#
# 用法（在 ops/dev-pipeline 下）：bash scripts/expose.sh
set -euo pipefail

PORT="${PORT:-8200}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

echo "启动 dev-pipeline 服务 :$PORT ..."
uv run uvicorn dev_pipeline.app:app --host 127.0.0.1 --port "$PORT" >/tmp/dev-pipeline.log 2>&1 &
SVC_PID=$!
trap 'kill $SVC_PID 2>/dev/null || true' EXIT

echo "起 cloudflare quick tunnel ..."
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >/tmp/dev-pipeline-cf.log 2>&1 &
CF_PID=$!
trap 'kill $SVC_PID $CF_PID 2>/dev/null || true' EXIT

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/dev-pipeline-cf.log | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "拿不到 tunnel URL，看 /tmp/dev-pipeline-cf.log" >&2
  exit 1
fi

echo ""
echo "✅ 公网 URL: $URL"
echo "   健康检查:  curl $URL/healthz"
echo "   下一步把 Linear 指过来:"
echo "     uv run python scripts/wire_linear.py --base-url $URL"
echo ""
echo "（Ctrl-C 结束；服务 + tunnel 会一起退出）"
wait
