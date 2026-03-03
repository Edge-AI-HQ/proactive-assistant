#!/usr/bin/env bash
set -euo pipefail

echo "🐾 Testing OpenClaw VNC locally"
echo "================================"

# 清理旧容器
docker rm -f openclaw-vnc-test 2>/dev/null || true

# 创建测试配置
cat > /tmp/openclaw-test-config.json << 'EOF'
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "test-token-123"
    },
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
EOF

# 启动容器
echo ""
echo "📦 Starting container..."
docker run -d \
  --name openclaw-vnc-test \
  -p 18789:18789 \
  -p 8444:8444 \
  -v /tmp/openclaw-test-config.json:/app/config/openclaw.json \
  -e OPENCLAW_CONFIG_PATH=/app/config/openclaw.json \
  -e OPENCLAW_GATEWAY_PORT=18789 \
  -e VNC_PORT=8444 \
  -e DISPLAY=:1 \
  openclaw-vnc-test:local \
  sh -c '
    # Setup VNC
    mkdir -p /root/.vnc /app/data/vnc
    echo "pinai123" | vncpasswd -f > /app/data/vnc/passwd
    chmod 600 /app/data/vnc/passwd
    ln -sf /app/data/vnc/passwd /root/.vnc/passwd
    
    # Create xstartup
    cat > /root/.vnc/xstartup << "XSTARTUP_EOF"
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
XSTARTUP_EOF
    chmod +x /root/.vnc/xstartup
    
    # Start VNC server
    echo "Starting VNC server..."
    vncserver :1 -geometry 1920x1080 -depth 24 -rfbport 8444 -localhost no -SecurityTypes VncAuth 2>&1 | tee /tmp/tigervnc.log &
    sleep 5
    
    # Check VNC status
    echo "VNC server status:"
    ps aux | grep vnc || true
    netstat -tlnp | grep 8444 || true
    
    # Start OpenClaw
    echo "Starting OpenClaw..."
    exec openclaw gateway --bind lan
  '

echo ""
echo "✅ Container started!"
echo ""
echo "📋 Container info:"
docker ps | grep openclaw-vnc-test

echo ""
echo "⏳ Waiting for services to start (10 seconds)..."
sleep 10

echo ""
echo "🔍 Checking logs..."
docker logs openclaw-vnc-test 2>&1 | tail -30

echo ""
echo "🧪 Testing connections:"
echo ""

# Test VNC port
echo "1. Testing VNC port (8444):"
if nc -zv localhost 8444 2>&1 | grep succeeded; then
  echo "   ✅ VNC port is open"
else
  echo "   ❌ VNC port is not responding"
fi

echo ""
echo "2. Testing OpenClaw Gateway (18789):"
if nc -zv localhost 18789 2>&1 | grep succeeded; then
  echo "   ✅ Gateway port is open"
else
  echo "   ❌ Gateway port is not responding"
fi

echo ""
echo "📊 Process status inside container:"
docker exec openclaw-vnc-test ps aux | grep -E "vnc|openclaw|xfce" || true

echo ""
echo "🌐 Access URLs:"
echo "   - VNC (manual): vnc://localhost:8444 (password: pinai123)"
echo "   - OpenClaw Gateway: http://localhost:18789"
echo ""
echo "🛠️  Useful commands:"
echo "   - View logs: docker logs -f openclaw-vnc-test"
echo "   - Enter container: docker exec -it openclaw-vnc-test bash"
echo "   - Stop container: docker stop openclaw-vnc-test"
echo "   - Remove container: docker rm -f openclaw-vnc-test"
echo ""
