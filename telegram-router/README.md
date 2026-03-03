# Telegram Router（dev）

统一接收 Telegram webhook，并按 `chat_id` 路由到对应 OpenClaw 容器；同时代理 OpenClaw 的 Telegram 出站请求。

## 功能概览
- 入站：`/webhook/telegram` 接收 Telegram update，按用户映射转发到目标容器 webhook。
- 出站：`/api/telegram/*` 代理 Telegram Bot API。
- 路由目标：基于 `users.telegram_user_id -> assistants -> runtime_instances(runtime_ref)`。

## 本地快速测试
### 1. 配置环境变量
```bash
cd telegram-router
cp .env.example .env
# 填写 TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / SUPABASE_DB_URL
```

### 2. 启动服务
```bash
bun run dev
```

### 3. 用 ngrok 暴露本地端口
```bash
ngrok http 3001
```

### 4. 配置 Telegram webhook
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<YOUR_NGROK_HOST>/webhook/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

## Fly 部署（dev）
### 1. 创建 app（首次）
```bash
fly apps create pinclaw-telegram-router-dev
```

### 2. 配置 secrets
```bash
fly secrets set \
  TELEGRAM_BOT_TOKEN=<TELEGRAM_BOT_TOKEN> \
  TELEGRAM_WEBHOOK_SECRET=<TELEGRAM_WEBHOOK_SECRET> \
  SUPABASE_DB_URL=postgresql://postgres:<PASSWORD>@<HOST>:5432/postgres \
  FLY_APP_NAME=pinclaw-api-dev \
  -a pinclaw-telegram-router-dev
```

### 3. 部署
```bash
fly deploy -a pinclaw-telegram-router-dev
```

### 4. 指向 Router webhook
```bash
ROUTER_URL=$(fly info -a pinclaw-telegram-router-dev | awk '/Hostname/ {print $2}')

curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://${ROUTER_URL}/webhook/telegram\",
    \"secret_token\": \"<TELEGRAM_WEBHOOK_SECRET>\"
  }"
```

## 日志格式（当前）
- 入站：
  - `📨 inbound ts=... tg_time=... update_id=... chat_id=... user=... text="..."`
- 出站请求：
  - `🔄 Proxying Telegram API [tgapi_xxx] method=... chat_id=... machine_id=... runtime_ref=...`
- 出站响应：
  - `✅ Telegram API response [tgapi_xxx] status=... ok=... result_message_id=... result_chat_id=...`

## 常用排查
```bash
# Router 健康
curl https://pinclaw-telegram-router-dev.fly.dev/health

# Router 日志
fly logs -a pinclaw-telegram-router-dev

# OpenClaw 容器日志
fly logs -a pinclaw-api-dev
```

## 路由闭环检查
1. 看到入站 `inbound ... chat_id=...`
2. 看到 `Found container` + `Machine ID`
3. 看到 `Forwarded successfully`
4. 看到出站 `sendMessage` + `Telegram API response ... status=200`

## 技术机制（简版）
- OpenClaw 侧插件对 `globalThis.fetch` 做 monkey patch。
- 命中 `https://api.telegram.org/bot.../<method>` 时，改写到 Router：
  - `http://<router>/api/telegram/<method>`
- Router 再调用 Telegram 官方 API。
