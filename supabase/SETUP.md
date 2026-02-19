# Supabase 配置指南（PIN AI Assistant）

## 1. 创建项目
1. 登录 Supabase，创建一个新 project。
2. 记录 project region（建议和部署服务器同区域）。

## 2. 获取连接信息
在 Supabase 控制台进入 `Project Settings -> API`，拿到：
- `Project URL` -> 对应 `SUPABASE_URL`
- `service_role` key -> 对应 `SUPABASE_SERVICE_KEY`（仅后端可用）

不要把 `SUPABASE_SERVICE_KEY` 放到前端或公开仓库。

## 3. 初始化数据库 schema
1. 打开 `SQL Editor`。
2. 执行文件 `supabase/migrations/001_auth_schema.sql` 的全部 SQL。

执行后应创建以下表：
- `users`
- `oauth_sessions`
- `message_logs`
- `admin_users`
- `admin_sessions`
- `auth_allowlist`

## 4. 配置应用环境变量
在主服务 `.env` 中设置：

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=<service-role-key>
```

同时保留已有：
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `TELEGRAM_BOT_TOKEN`

## 5. Google OAuth 说明
当前认证仍由应用侧 `passport-google-oauth20` 处理，不依赖 Supabase Auth。

所以你需要在 Google Cloud Console 保证回调地址和 `.env` 一致：

```text
<PUBLIC_BASE_URL>/auth/google/callback
```

例如：
`https://api.pinai.io/auth/google/callback`

## 6. 验证
1. 重启服务。
2. Telegram 发送 `/start` 获取登录链接。
3. 完成 Google 登录后，检查 Supabase 表：
   - `oauth_sessions`（短暂记录，消费后会删除）
   - `users`（首次登录会插入）
4. 管理后台测试：
   - `/admin` 登录
   - `/admin/auth` 添加/删除 allowlist 条目
