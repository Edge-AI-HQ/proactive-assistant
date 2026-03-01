# Telegram Router 当前状态（2026-02-28）

## 文档目的
沉淀本次“公司公用 Telegram Bot -> 按用户路由到各自 OpenClaw 容器”方案的：
- 当前实现路径
- 已验证结果
- 已知问题
- 接手排查手册

时间基准：
- UTC：2026-02-28
- 本地（UTC+8）：2026-02-28

## 相关仓库
- OpenClaw 仓库（只读参考）：`/Users/smile/Documents/01PINAI/01Code/12repo/openclaw`
- PIN-AI-ASSISTANT（本次主要改动）：`/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT`

## 固定上下文（便于后续对话直接复用）
### 仓库路径
1. `openclaw`: `/Users/smile/Documents/01PINAI/01Code/12repo/openclaw`
2. `PIN-AI-ASSISTANT`: `/Users/smile/Documents/01PINAI/01Code/12repo/PIN-AI-ASSISTANT`

### 机器信息
- 同事机器：`2873974c4513d8`
- 你的机器（当前口径）：`8469e0c4d0328`
- 本次排查过程中的活跃测试机（Fly runtime_ref 命中）：`287d346c617928`
  - 说明：历史上出现过 `78469e0c4d0328`/`8469e0c4d0328`/`287d346c617928` 等不同实例，后续排查请始终先以 router 日志中实时命中的 runtime_ref 为准。
  - 补充：Fly 机器在重建/更新后，`machine_id` 可能变化；不要把历史 machine_id 当作长期稳定主键。

### 测试 Bot
- `@pinai_claw_smile_test_bot`

## 目标架构
入站：
1. 用户给公用 Telegram Bot 发消息。
2. Telegram webhook 打到 `pinclaw-telegram-router-dev` 的 `/webhook/telegram`。
3. Router 根据 `chat_id` 查 DB，定位目标 assistant/runtime 机器。
4. Router 转发到该 OpenClaw 机器的 webhook（`:8787/telegram-webhook`）。

出站：
1. OpenClaw 产出 typing/action 与最终文本消息。
2. 预期所有 Telegram API 出站都走 router 的 `/api/telegram/*` 代理。
3. Router 再调用 Telegram Bot API。

## 消息机制讲透（面向“为什么能拦截”）
### 1）原版（私人 Bot 直连）机制
入站：
1. Telegram 直接把 update 发送给该用户 OpenClaw（webhook）或由 OpenClaw 自己 polling 拉取。
2. OpenClaw 在容器内处理消息并触发 agent。

出站：
1. OpenClaw 直接请求 `https://api.telegram.org/bot<TOKEN>/<method>`。
2. Telegram 把消息回给用户。

要点：
- 原版没有公司级 Router 作为统一入口/出口。
- 每个用户容器“自己收、自己发”。

### 2）当前（公用 Bot + Router）机制
入站：
1. 公用 Bot 的 webhook 统一打到 Router（`/webhook/telegram`）。
2. Router 根据 `chat_id -> user -> assistant -> runtime` 映射，把 update 转发到目标 OpenClaw 容器 webhook（`/telegram-webhook`）。

出站：
1. OpenClaw 内部仍按原逻辑“调用 Telegram API”。
2. 但调用前会被插件改写到 Router（`/api/telegram/<method>`）。
3. Router 代 OpenClaw 调 Telegram 官方 API，再把结果返回。

### 3）Monkey Patch 到底是什么
定义：
- Monkey Patch = 在运行时替换函数实现（不改上游源码主干）。

在本方案里：
- 插件在 OpenClaw 启动后，把 `globalThis.fetch` 包一层。
- 当发现目标 URL 是 `api.telegram.org/bot.../<method>` 时，改写到 Router 地址。
- 非 Telegram 请求不改写，走原始 `fetch`。

为什么拦截 `fetch` 而不是“拦截 POST/GET”：
- `POST/GET` 是 HTTP 方法，不是代码入口。
- `fetch` 是发 HTTP 请求的函数入口；多数 Node 侧网络请求会经过它。
- 拦截 `fetch` 能在请求真正发出前改写目标地址。

### 4）插件具体代码位置
文件：
- `openclaw-plugins/telegram-router-proxy/index.ts`

关键点：
- 启动与版本标记：`Telegram Router Proxy enabled`、`TRP_VERSION_20260228A`
- 安装 fetch patch：`installTelegramFetchProxy(...)`
- 替换 `globalThis.fetch`
- 解析 Telegram method：`extractTelegramMethod(...)`
- 重写目标到：`<TELEGRAM_ROUTER_URL>/api/telegram/<method>`

Router 对应入口：
- `telegram-router/index.ts`
- `/api/telegram/*`（统一代理到 Telegram 官方 API）

### 5）“能保证拦截到吗”的边界
可以保证：
- 走 `fetch` 且命中 `api.telegram.org/bot.../<method>` 的请求会被改写。

不能 100% 保证：
- 如果上游未来改成不走 `fetch`（例如直接 `http.request`），该 patch 不会命中。

当前实证：
- Router 日志已多次出现 `POST /api/telegram/sendChatAction` 且返回 200，说明 patch 已生效。

## 本次已实施内容
### 1）Router 服务代码更新
文件：
- `telegram-router/index.ts`

改动：
- `handleTelegramApiProxy` 从“仅 JSON 转发”改为“透明 body 转发（支持二进制）”。
- 保留并透传 `content-type`，兼容媒体类 Telegram API。

### 2）OpenClaw 出站代理插件更新
文件：
- `openclaw-plugins/telegram-router-proxy/index.ts`

改动：
- 使用全局 fetch 拦截：匹配 `https://api.telegram.org/bot.../<method>`，重写到 `TELEGRAM_ROUTER_URL/api/telegram/<method>`。
- 增加启动标记日志：`TRP_VERSION_20260228A`。
- 增加日志：`Telegram fetch proxy patch installed`。

### 3）单机安全发布（避免影响其他用户）
机器：
- `pinclaw-api-dev / 287d346c617928`（仅测试机）

已做：
- 通过 machine 启动命令补丁，在每次启动时先把新插件写入 `/opt/pinai/plugins/telegram-router-proxy/index.ts`，再启动 OpenClaw。
- 仅该机设置环境变量：
  - `TELEGRAM_ROUTER_URL=http://pinclaw-telegram-router-dev.internal:8080`

原因：
- 不改第三方 OpenClaw 上游仓库代码。
- 不做全量机器变更，先单机验证闭环。

## 已验证事实（基于日志）
### A）入站路由可用
- Router 能收到用户消息（如“1+1”、“今日几号”）。
- Router 能定位到目标机器并转发成功（`:8787/telegram-webhook`）。

### B）出站已经过 router API（至少 action 阶段）
- Router 日志可见：
  - `POST /api/telegram/sendChatAction`
  - `Proxying Telegram API: sendChatAction`
  - `Telegram API response: 200`
- 说明出站不再完全是 OpenClaw 直连 Telegram。

### C）最终文本回复仍不稳定，主要被上游模型阻塞
- OpenClaw 日志多次出现：
  - `embedded run agent end ... isError=true error=502 status code (no body)`
- 用户侧会收到：
  - `502 status code (no body)`
- LiteLLM 日志持续出现：
  - `instance refused connection`
  - `could not find a good candidate ... /chat/completions`

结论：
- Router 链路基本通了。
- 当前“没最终回复”的主阻塞点是 LiteLLM 可用性，不是 webhook 转发。

## 当前运行对象
- Router App：`pinclaw-telegram-router-dev`
- API/容器宿主 App：`pinclaw-api-dev`
- 会话中稳定命中的测试用户机器：`287d346c617928`
- 你提供的用户机器 ID：`8469e0c4d0328`
- 同事机器：`2873974c4513d8`（已完成单机补丁改造）

## 2026-03-01 增量更新（本轮）
### 1）同事机器已完成同款改造
目标机器：
- `pinclaw-api-dev / 2873974c4513d8`

已确认生效：
- `TELEGRAM_ROUTER_URL=http://pinclaw-telegram-router-dev.internal:8080`
- 启动日志出现：
  - `Telegram Router Proxy enabled: http://pinclaw-telegram-router-dev.internal:8080`
  - `TRP_VERSION_20260228A`
  - `Telegram fetch proxy patch installed`

说明：
- 只改该单机，未动其他用户机器配置。

### 2）“模拟同事发消息”验证结果
先后两次模拟：
1. 使用错误 chat_id `8043169438`
   - Router 返回：`No container found for chat_id: 8043169438`
2. 使用同事真实 chat_id `5572561504`
   - 命中机器：`Machine ID: 2873974c4513d8`
   - 转发成功：`Forwarded successfully via http://[fdaa:...:ff7b:2]:8787/telegram-webhook`

关键结论：
- 路由按“chat_id -> runtime_ref”分发是生效的。
- chat_id 必须与 DB 映射一致，否则会出现 No container found。

### 3）Router 出站回复日志已补强并部署
代码：
- `telegram-router/index.ts` 已新增出站结构化日志字段。

已部署：
- App：`pinclaw-telegram-router-dev`
- 部署镜像：`deployment-01KJM7R9X57QSDB9KABQ3NYSJ1`

新日志字段（`/api/telegram/*`）：
- `trace_id`（形如 `tgapi_xxx`）
- `method`
- `chat_id`（回复给谁）
- `machine_id`
- `runtime_ref`
- `source`
- `content_type`
- `body_bytes`
- 响应侧：`status`、`ok`、`result_message_id`、`result_chat_id`、`description`

已在线冒烟验证（无效 chat_id）：
- `Proxying Telegram API [tgapi_...] method=sendMessage chat_id=0 machine_id=unknown ...`
- `Telegram API response [tgapi_...] status=400 ok=false ... description=Bad Request: chat not found`

## 快速排查手册（可直接执行）
### 1）查入站路由
```bash
flyctl logs -a pinclaw-telegram-router-dev -n | rg "inbound ts=|Found container|Machine ID|Forwarded successfully|Forward failed|No container found"
```

### 2）查测试机运行与插件加载
```bash
flyctl logs -a pinclaw-api-dev -i 287d346c617928 -n | rg "TRP_VERSION_20260228A|fetch proxy patch installed|embedded run agent end|sendMessage ok"
```

### 3）查 LiteLLM 健康
```bash
flyctl logs -a litellm-dev -n | rg "refused connection|could not find a good candidate|/chat/completions|error"
flyctl status -a litellm-dev
flyctl machine list -a litellm-dev
```

### 4）验证测试机到 router 内网可达
```bash
flyctl ssh console -a pinclaw-api-dev --machine 287d346c617928 -C \
  "node -e \"fetch('http://pinclaw-telegram-router-dev.internal:8080/health').then(r=>r.text()).then(console.log).catch(console.error)\""
```

### 5）模拟用户发消息并检查闭环（推荐）
说明：
- 适用于不依赖 Telegram 客户端的人为注入测试。
- 前提是先拿到该用户真实 `telegram_user_id`（chat_id）。

步骤 A：先查某 runtime 当前绑定的 chat_id
```bash
flyctl ssh console -a pinclaw-telegram-router-dev -C \
  'node -e "(async()=>{const {default:postgres}=await import(\"postgres\");const sql=postgres(process.env.DATABASE_URL);const rows=await sql.unsafe(\"select u.telegram_user_id,a.id assistant_id,r.runtime_ref from users u join assistants a on a.owner_user_id=u.id left join runtime_instances r on r.assistant_id=a.id and r.scope=$1 where r.runtime_ref like $2 order by r.updated_at desc limit 10\",[\"assistant\",\"%2873974c4513d8%\"]);console.log(JSON.stringify(rows,null,2));await sql.end();})().catch(e=>{console.error(e);process.exit(1);});"'
```

步骤 B：向 Router 注入模拟 update（把 `5572561504` 换成目标 chat_id）
```bash
flyctl ssh console -a pinclaw-telegram-router-dev -C \
  'node -e "(async()=>{const uid=991000000+Math.floor(Date.now()/1000)%1000000;const txt=\"sim-e2e-\"+Date.now();const payload={update_id:uid,message:{message_id:uid,from:{id:5572561504,is_bot:false,first_name:\"sim\",username:\"sim_user\"},chat:{id:5572561504,type:\"private\"},date:Math.floor(Date.now()/1000),text:txt}};const r=await fetch(\"http://127.0.0.1:8080/webhook/telegram\",{method:\"POST\",headers:{\"content-type\":\"application/json\",\"x-telegram-bot-api-secret-token\":\"<WEBHOOK_SECRET>\"},body:JSON.stringify(payload)});console.log(JSON.stringify({uid,txt,status:r.status,body:await r.text()}));})().catch(e=>{console.error(e);process.exit(1);});"'
```
注：上面 `<WEBHOOK_SECRET>` 需替换成当前 router 使用的 secret。

步骤 C：看 Router 入站是否命中目标机器
```bash
flyctl logs -a pinclaw-telegram-router-dev --no-tail | \
  rg 'Received update|Chat ID|Found container|Machine ID|Forwarded successfully|No container found'
```

步骤 D：看 Router 出站是否成功回发 Telegram
```bash
flyctl logs -a pinclaw-telegram-router-dev --no-tail | \
  rg 'Proxying Telegram API \[tgapi_|Telegram API response \[tgapi_'
```

闭环判定标准：
1. 入站能看到目标 `chat_id`。
2. `Found container` 命中目标 runtime/machine。
3. `Forwarded successfully` 到目标容器 webhook。
4. 出站出现 `sendMessage` 且 `Telegram API response ... status=200`。

## 日志补强建议（建议尽快加）
目标：
- 一条用户消息能用同一个“追踪键”串起 Router 入站 -> OpenClaw 执行 -> Router 出站。

### 1）统一追踪键
建议字段：
- `trace_id`（优先）：`tg:<chat_id>:<update_id>`
- `chat_id`
- `update_id`
- `assistant_id`
- `machine_id/runtime_ref`
- `method`（sendMessage/sendChatAction）

### 2）Router 入站日志（/webhook/telegram）
建议固定打：
- `event=telegram_inbound_received`
- `trace_id/chat_id/update_id`
- `resolved_assistant_id/runtime_ref`
- `forward_url`
- `forward_result`（success/fail + status + latency_ms）

### 3）OpenClaw 插件日志（fetch 改写处）
建议固定打：
- `event=telegram_fetch_rewrite`
- `trace_id`（从上下文/metadata 透传，没有就至少打 chat_id）
- `original_method`（sendMessage 等）
- `proxy_url`
- `rewrite_result`（ok/fail + status）

### 4）Router 出站日志（/api/telegram/*）
建议固定打：
- `event=telegram_outbound_proxy`
- `trace_id/chat_id/method`
- `telegram_status`
- `latency_ms`

当前状态（2026-03-01）：
- 已部分落地，至少包含：`trace_id/method/chat_id/machine_id/runtime_ref/status/ok/result_message_id/result_chat_id/description`

### 5）模型调用链日志（OpenClaw/LiteLLM）
建议固定打：
- `event=model_request_start/model_request_end`
- `trace_id`
- `model`
- `provider`
- `status`
- `error_code/error_message`

### 6）最小验收标准
当用户发一条消息时，应至少能看到：
1. Router 入站 `telegram_inbound_received`
2. OpenClaw 插件 `telegram_fetch_rewrite`（至少 sendChatAction）
3. Router 出站 `telegram_outbound_proxy`（method + status）
4. 失败时有明确模型错误（避免仅 `502 no body`）

## 已知缺口与后续建议
1. 优先稳定 LiteLLM 服务可用性（这是最终文本回复失败的主因）。
2. LiteLLM 稳定后，继续确认 router 日志出现：
   - `POST /api/telegram/sendMessage`
   - `Proxying Telegram API: sendMessage`
3. 按需保留或移除临时日志标记 `TRP_VERSION_20260228A`。
4. 单机验证稳定后，再规划镜像级/全量发布方案。

## 安全说明
- 文档中不要保留生产密钥、bot token 明文。
- 若历史文档存在旧测试 token，建议统一轮换并失效处理。
