# MiniApp Google OAuth Design

## Goal
将 Google 授权管理收敛为 miniapp 唯一入口。用户在 miniapp 管理页完成连接/断开；OAuth 回调落在 `apis`；成功后自动返回 miniapp 管理页并刷新为已连接状态，同时 Telegram bot 主动发送连接成功与使用提醒。

## Current Context
- miniapp 已有管理入口：`miniapp/src/components/ManageAgentDialog.tsx`
- miniapp 状态由 `GET /api/mini/state` 提供，组装逻辑在 `apis/src/controller/dashboard_routes.ts`
- 现有 Google OAuth 路由在 `apis/src/controller/google_oauth_routes.ts`
- 现有回调已能完成：授权、落库、自动同步凭据到容器、bot `/start google_connected` 提示
- 旧 `/google/manage` 页面目前仍存在，但产品上不应再暴露

## Requirements
1. miniapp 是用户唯一入口
2. miniapp 管理页可见 Google 连接状态、已连接邮箱、Connect、Disconnect
3. 授权从 miniapp 发起，回调完成后自动回 miniapp 管理页
4. 返回 miniapp 后立即刷新状态，并提示用户回 bot 使用
5. bot 同时主动发送连接成功与推荐能力提示
6. 旧 `/google/manage` 仅保留开发调试，不在 miniapp 中露出

## Recommended Architecture
采用“miniapp 主导，apis 持有 OAuth 与凭据落库”的结构。

### Why
- OAuth client secret、state 验证、token exchange 继续留在 `apis`，安全边界不变
- miniapp 只消费状态和发起动作，前端不处理敏感 token
- callback 后 `302` 回 miniapp，状态来源仍只有 `/api/mini/state`
- 容器同步仍在服务端完成，避免前端参与运行时写文件

## Data Flow
1. 用户在 miniapp 管理页点击 `Connect Google`
2. miniapp 打开 `GET /mini/google/start`
3. `apis` 从 mini session 中拿 `telegram_user_id`，生成 Google OAuth URL，并把 `nextPath` 设为 miniapp 管理页返回地址
4. Google 授权后回调 `GET /mini/google/callback`
5. callback 完成：
   - consume state
   - token exchange
   - 获取 userinfo 邮箱
   - 保存 DB 凭据
   - 自动下发到容器
   - 触发 bot 连接成功消息
   - `302` 到 `/mini?google=connected`
6. miniapp 启动或路由变更时检测 `google=connected`
   - 重新拉 `/api/mini/state`
   - Toast 显示已连接邮箱
   - 管理页状态变为 connected
7. 用户可点击 `Disconnect`
   - 调 `POST /api/mini/google/disconnect`
   - 删除 DB 凭据
   - 刷新 mini state

## API Changes
### Extend `/api/mini/state`
新增字段：
```ts
google: {
  connected: boolean;
  email: string | null;
  scopes: string;
  updatedAt: string;
}
```

### New miniapp routes
- `GET /mini/google/start`
  - 需要 mini session
  - 服务端决定 telegram user id
- `GET /mini/google/callback`
  - 处理 Google 回调
  - 成功后重定向 miniapp
- `POST /api/mini/google/disconnect`
  - 需要 mini session
  - 断开 Google 凭据
- 可选：`GET /api/mini/google/status`
  - 如果 `/api/mini/state` 已包含 google 字段，可不必单独新增

## Frontend Changes
### App state
- `StatePayload` 扩展 `google`
- 增加 query param 检测：`google=connected`、`google=disconnected`、`google_error=...`
- 成功时显示 toast，并刷新 mini state

### Manage dialog
在 `ManageAgentDialog` 中加入 Google 管理卡片：
- 未连接：`Connect Google`
- 已连接：显示邮箱和 `Disconnect`
- 点击 connect 跳转 `/mini/google/start`
- 点击 disconnect 调 API，再刷新状态

## Bot Messaging
沿用现有 `start=google_connected` 逻辑，但 callback 除了重定向 miniapp 外，还要主动向当前 Telegram 用户发一条成功消息：
- connected mailbox
- credentials synced
- example prompts

这样即使用户没有立即切回 bot，消息也已经在聊天里。

## Error Handling
- Google start 失败：返回 miniapp 可识别错误页或回 `/mini?google_error=...`
- callback 失败：重定向 `/mini?google_error=oauth_failed`
- 同步容器失败：不中断 OAuth 成功，但在 miniapp 和 bot 中明确提示“connected but sync failed”
- disconnect 失败：前端 toast 展示错误，不做本地假更新

## Testing
1. 后端单测
- `buildMiniStatePayload` 包含 google 字段
- `/mini/google/start` 需要 mini session
- `/api/mini/google/disconnect` 能删除凭据
- callback 成功后返回 mini redirect

2. 前端单测/组件测试
- `ManageAgentDialog` 能显示 connected / disconnected 状态
- `google=connected` 时刷新状态并展示 toast

3. 本地联调
- `apis`: `npm run local:up`
- `miniapp`: 本地 dev server `3002`
- ngrok 指向 `3002`，Google redirect URI 指向 `https://<ngrok>/mini/google/callback`
- 在 Telegram miniapp 中测试 connect / disconnect / 回 bot 提示

## Rollout Notes
- 产品入口只保留 miniapp
- 旧 `/google/manage` 保留作为开发调试页，不在 UI 中暴露
- 线上接入前需要补正式 miniapp/ngrok/redirect URI 配置
