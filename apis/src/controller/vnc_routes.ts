import { Router, type Request } from "express";
import crypto from "node:crypto";
import { pool } from "../domain/common/db/core.js";

const router = Router();

interface VncAccessToken {
  id: number;
  assistant_id: number;
  token: string;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  used_from_ip: string | null;
  bot_id?: number;
}

interface SessionRequest extends Request {
  session?: {
    userId?: number;
  };
}

// 生成 VNC 访问令牌（15分钟有效期）
router.post(
  "/api/vnc/request-access/:assistantId",
  async (req: SessionRequest, res) => {
    try {
      const assistantId = Number.parseInt(req.params.assistantId || "", 10);
      if (!Number.isFinite(assistantId)) {
        return res.status(400).json({ error: "Invalid assistant ID" });
      }

      // 验证 assistant 是否存在并获取容器信息
      const assistantResult = await pool.query(
        `SELECT 
          a.id, 
          a.owner_user_id, 
          a.assistant_bot_id,
          r.runtime_ref as container_id,
          r.status as container_status
         FROM assistants a
         LEFT JOIN runtime_instances r ON r.assistant_id = a.id
         WHERE a.id = $1`,
        [assistantId],
      );

      if (!assistantResult.rows.length) {
        return res.status(404).json({ error: "Assistant not found" });
      }

      const assistant = assistantResult.rows[0];

      // 权限验证（支持内部调用和用户会话）
      const userId = req.session?.userId;
      const isInternalCall = req.headers.cookie?.includes(
        "session_id=internal-telegram-bot",
      );

      if (!isInternalCall && (!userId || assistant.owner_user_id !== userId)) {
        return res.status(403).json({ error: "Access denied" });
      }

      // 检查容器是否在运行
      if (!assistant.container_id || assistant.container_status !== "running") {
        return res.status(400).json({
          error:
            assistant.container_status === "creating"
              ? "Container is still starting. Please wait a moment."
              : "Container not running. Please start your assistant first.",
        });
      }

      // 生成访问令牌
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15分钟

      await pool.query(
        `INSERT INTO vnc_access_tokens (assistant_id, token, expires_at)
       VALUES ($1, $2, $3)`,
        [assistantId, token, expiresAt],
      );

      // 构建访问 URL
      const vncUrl = `${req.protocol}://${req.get("host")}/vnc/${token}`;

      return res.json({
        url: vncUrl,
        token,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: 900,
      });
    } catch (error: unknown) {
      console.error("VNC access request error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

// VNC 代理页面（验证令牌后显示 noVNC 客户端）
router.get("/vnc/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || typeof token !== "string") {
      return res.status(400).send("Invalid token");
    }

    // 查询令牌和容器信息
    const result = await pool.query<
      VncAccessToken & {
        runtime_ref: string | null;
        container_status: string | null;
      }
    >(
      `SELECT 
        t.*,
        r.runtime_ref,
        r.status as container_status
       FROM vnc_access_tokens t
       JOIN assistants a ON t.assistant_id = a.id
       LEFT JOIN runtime_instances r ON r.assistant_id = a.id
       WHERE t.token = $1`,
      [token],
    );

    if (!result.rows.length) {
      return res.status(404).send("Access token not found");
    }

    const tokenRecord = result.rows[0];
    if (!tokenRecord) {
      return res.status(404).send("Access token not found");
    }

    // 检查是否过期
    if (new Date() > tokenRecord.expires_at) {
      return res.status(403).send("Access token expired");
    }

    // 记录使用
    const clientIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    if (!tokenRecord.used_at) {
      await pool.query(
        "UPDATE vnc_access_tokens SET used_at = NOW(), used_from_ip = $1 WHERE id = $2",
        [clientIp, tokenRecord.id],
      );
    }

    // 检查容器是否在运行
    if (
      !tokenRecord.runtime_ref ||
      tokenRecord.container_status !== "running"
    ) {
      return res.status(503).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Container not available</h1>
            <p>The assistant container is not running. Please start your assistant first.</p>
            <p>Status: ${tokenRecord.container_status || "not created"}</p>
          </body>
        </html>
      `);
    }

    // 从 runtime_ref 提取 IPv6 公网地址
    // 格式：fly:84e1e0b274d3d8|fdaa:48:2900:a7b:1b7:6e2f:ed88:2
    const ipv6 = tokenRecord.runtime_ref.split("|")[1];
    if (!ipv6) {
      return res.status(503).send("Invalid container reference - no IPv6");
    }

    // 构建 VNC WebSocket URL
    // Fly.io 的 IPv6 地址是公网可访问的，直接连接
    const vncProxyPort = 8445;
    const vncWsUrl = `wss://[${ipv6}]:${vncProxyPort}`;

    // 返回 noVNC 客户端页面
    return res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PIN AI - 远程桌面</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a1a;
      color: #fff;
      overflow: hidden;
    }
    #toolbar {
      background: #2d2d2d;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    #toolbar h1 {
      font-size: 18px;
      font-weight: 600;
      color: #fff;
    }
    #toolbar .info {
      font-size: 14px;
      color: #999;
    }
    #vnc-container {
      width: 100vw;
      height: calc(100vh - 60px);
      position: relative;
      background: #000;
    }
    #vnc-status {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: #999;
    }
    #vnc-screen {
      width: 100%;
      height: 100%;
      display: none;
    }
    .spinner {
      border: 4px solid rgba(255,255,255,0.1);
      border-top: 4px solid #fff;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <h1>🐾 PIN AI 远程桌面</h1>
    <div class="info">助理容器桌面访问</div>
  </div>
  <div id="vnc-container">
    <div id="vnc-status">
      <div class="spinner"></div>
      <p>正在连接到远程桌面...</p>
    </div>
    <div id="vnc-screen"></div>
  </div>

  <script type="module">
    import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.4.0/core/rfb.js';

    const vncWsUrl = ${JSON.stringify(vncWsUrl)};
    const vncPassword = 'pinai123';
    const statusEl = document.getElementById('vnc-status');
    const screenEl = document.getElementById('vnc-screen');

    try {
      const rfb = new RFB(screenEl, vncWsUrl, {
        credentials: { password: vncPassword },
        wsProtocols: ['binary']
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = true;

      rfb.addEventListener('connect', () => {
        statusEl.style.display = 'none';
        screenEl.style.display = 'block';
        console.log('VNC connected');
      });

      rfb.addEventListener('disconnect', (e) => {
        statusEl.innerHTML = '<p style="color: #ff6b6b;">连接已断开</p>';
        statusEl.style.display = 'block';
        screenEl.style.display = 'none';
        console.log('VNC disconnected:', e.detail);
      });

      rfb.addEventListener('credentialsrequired', () => {
        statusEl.innerHTML = '<p style="color: #ffd93d;">等待身份验证...</p>';
      });

      rfb.addEventListener('securityfailure', (e) => {
        statusEl.innerHTML = '<p style="color: #ff6b6b;">认证失败</p>';
        console.error('VNC security failure:', e.detail);
      });

    } catch (error) {
      console.error('VNC init error:', error);
      statusEl.innerHTML = '<p style="color: #ff6b6b;">初始化失败</p>';
    }
  </script>
</body>
</html>
    `);
  } catch (error: unknown) {
    console.error("VNC proxy error:", error);
    return res.status(500).send("Internal server error");
  }
});

export default router;
