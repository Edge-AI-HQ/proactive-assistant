# Telegram Router 当前状态（初始记录：2026-02-28，最后更新：2026-03-03）

## TL;DR（当前口径）
1. Telegram Router 已并入 `apis` 服务，独立 `telegram-router` Fly app 已下线。
2. 当前入站 webhook 与出站 Telegram API 代理都由 `pinclaw-api-dev` 承载。
3. 仓库中的历史独立服务代码已删除（commit `531ccc2`）。
4. 目前主要风险不在“路由是否生效”，而在 OpenClaw 冷启动耗时与 CPU 限流。

---

## 当前架构（2026-03-03 生效）

消息流：

```text
Telegram API
  -> pinclaw-api-dev /webhook/telegram(*/public/private)
  -> apis/src/domain/telegram-router/routes.ts
  -> 目标 OpenClaw 容器 :8787/telegram-webhook

OpenClaw 容器
  -> telegram-router-proxy 插件重写 Telegram API 请求
  -> pinclaw-api-dev /api/telegram/:method
  -> Telegram API
```

关键点：
- 不再依赖 `pinclaw-telegram-router-dev`。
- Router 逻辑代码位置：`apis/src/domain/telegram-router/routes.ts`。
- API 启动注册位置：`apis/src/server.ts`。
- OpenClaw 插件仍保留 `telegram-router-proxy`，用于重写出站 Telegram 请求。

---

## 本轮合并与收口清单

### 代码侧
- 已将 Router 路由并入 APIs：
  - `POST /webhook/telegram`
  - `POST /webhook/telegram/public`
  - `POST /webhook/telegram/private`
  - `ALL /api/telegram/:method`
- 已把 OpenClaw 注入环境变量改为指向 APIs 内路由（不再依赖独立 Router app）。
- 为避免回退到轮询/错误默认值，已补 webhook URL fallback 与强制注入。

相关提交：
- `3bebddb` `feat(apis): merge telegram router endpoints into api service`
- `def81a1` `fix(telegram-router): enforce webhook url fallback to avoid polling fallback`
- `531ccc2` `chore(telegram): remove legacy router service code`

### 基础设施侧
- 旧独立服务机器已下线（`pinclaw-telegram-router-dev` 不再作为运行依赖）。
- 当前验证与排障入口统一为 `pinclaw-api-dev` 日志。

---

## 已知现象与结论（你这轮实测）

### 现象 A：曾出现 `Forward failed on all candidate endpoints` / `ECONNRESET`
结论：
- 主要发生在切换期间 webhook URL/注入配置不完整，或目标容器未完全就绪时。
- 修正为 APIs webhook 地址并完成重建后，链路恢复。

### 现象 B：容器“卡住很久”
结论：
- 不是卡死，主要是 OpenClaw 冷启动阶段运行时编译与缓存构建（jiti + Node V8 compile cache）叠加 `shared-cpu-1x` 限流。
- 指标表现：高 load、接近满 CPU、throttle 持续偏高，随后在就绪点后快速回落。

---

## 为什么慢（固定认知，便于后续复用）

1. OpenClaw 首次冷启动会触发运行时编译/缓存生成（不是 `npm run build`）。
2. `/tmp` 缓存在 destroy+create 后会丢失，导致再次冷启动重复成本。
3. `shared-cpu-1x` 下 CPU 配额节流明显，会放大首次启动耗时。

---

## 建议的运行策略（按收益排序）

1. 创建期升配（如 `shared-cpu-2x` 或 `performance-1x`），就绪后降配。
2. 保留 volume，尽量避免频繁 destroy+create（提高缓存命中）。
3. 继续保持插件入口走预编译 `index.js`。
4. 创建后先做预热探测，再对用户宣告“可用”。

---

## 当前排障命令（以 APIs 为准）

### 1）看 Telegram 入站/转发/出站代理日志
```bash
flyctl logs -a pinclaw-api-dev -n | rg "inbound ts=|Forward failed|Forwarded successfully|Proxying Telegram API|Telegram API response"
```

### 2）看某台 assistant machine 冷启动轨迹
```bash
flyctl logs -a pinclaw-api-dev -i <machine_id> -n | rg "pulling|Machine started|TRP_VERSION|fetch proxy patch installed|Fully ready|telegram-webhook|ECONNRESET|502"
```

### 3）确认 APIs 侧 webhook 配置
```bash
flyctl secrets list -a pinclaw-api-dev | rg "TELEGRAM_ROUTER_WEBHOOK_URL|TELEGRAM_WEBHOOK_SECRET|OPENCLAW_TELEGRAM_WEBHOOK_PATH"
```

---

## 历史说明（保留）

- 本文最初用于记录“独立 `telegram-router` Bun 服务”阶段（2026-02-28）。
- 自 2026-03-03 起，生产/测试口径均已切换为“Router in APIs”。
- 若看到旧命令仍指向 `pinclaw-telegram-router-dev`，应视为历史资料，不再作为执行手册。

---

## 安全说明

- 文档中不得保留 bot token、webhook secret、数据库连接串明文。
- 如历史记录出现敏感值，需立即轮换并清理。

## 开发经验（2026-03-05）

- 不要把 OpenClaw 完整配置 JSON 内联到 Fly `init.exec` 命令中；Fly 启动日志会打印 `Preparing to run`，会泄露明文配置。
- 容器启动改为 `OPENCLAW_CONFIG_B64` 注入，容器内再 `base64 -d` 落盘到 `OPENCLAW_CONFIG_PATH`，避免命令行明文。
- 就绪判定不能只看 `running/port`；必须额外探测 Telegram webhook HTTP 可用（`webhookPort + webhookPath`），再对用户发送 ready 通知。
- P0 校验口径固定：assistant 容器内不应出现 `telegram.token`、`telegram.webhookSecret`、`elevenlabs.apiKey` 明文。
