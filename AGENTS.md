# Repository Guidelines

## 当前架构（一句话）
Telegram Router 已并入 `apis`，不存在独立 `telegram-router` 服务。所有 Telegram 入/出站统一走 `pinclaw-api-dev`。

## 快速定位（高频目录）
- `apis/src/domain/telegram-router/`：Telegram 路由核心逻辑（入站 webhook + 出站 API 代理）。
- `apis/src/domain/container/`：OpenClaw 机器创建/重建与 env 注入。
- `openclaw-plugins/telegram-router-proxy/`：OpenClaw 内 Telegram 出站重写插件（`index.ts` + `index.js`）。
- `infra/container-manager/images/openclaw/`：自定义 OpenClaw 镜像。
- `ops/litellm/`：LiteLLM 本地运维脚本。
- `docs/`：运行记录与排障文档（默认被 `.gitignore` 忽略）。

## 开发命令（只留常用）
在仓库根目录执行：
- `npm install`
- `npm run dev`
- `npm run build`
- `npm run type-check`
- `npm run test --workspace @pin-ai/apis`

LiteLLM 本地命令：
- `npm run litellm:up`
- `npm run litellm:logs`

## 变更决策表（先看这个）
1. 改 `apis/` 代码：
- 直接提交并 `git push`，GitHub Actions 自动部署 `pinclaw-api-dev`。

2. 改 `openclaw-plugins/` 或 OpenClaw 启动行为：
- 必须重建并推送 OpenClaw 镜像；
- 然后更新 `OPENCLAW_IMAGE`（必须 `@sha256:` 格式）。

3. 只改文档：
- `docs/` 默认被忽略，提交时需要 `git add -f docs/<file>`。

## 生产环境硬性规则（必须遵守）
- 生产环境（`pinclaw-api-prod`、`pinclaw-litellm-prod`）禁止直接执行任何 `flyctl` 命令。
- 生产环境禁止直接执行任何数据库变更（含手动 SQL、`migrate`、`db push`、`schema` 变更）。
- 所有生产变更必须走代码评审 + CI/CD 发布流程，不允许在终端临时“热修”。

## Telegram 路由运行规则（当前真相）
消息流：
```text
Telegram API -> APIs(/webhook/telegram*) -> OpenClaw webhook(:8787)
OpenClaw -> telegram-router-proxy -> APIs(/api/telegram/:method) -> Telegram API
```

关键配置：
- APIs secrets：
  - `TELEGRAM_ROUTER_WEBHOOK_URL`（建议为 APIs 的 `/webhook/telegram`）
  - `TELEGRAM_WEBHOOK_SECRET`
  - `OPENCLAW_IMAGE`（必须 digest）
- OpenClaw machine env：
  - `TELEGRAM_ROUTER_URL`（应指向 APIs）
  - `OPENCLAW_TELEGRAM_WEBHOOK_PATH`
  - `OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH`
  - `NODE_COMPILE_CACHE`

## 实战踩坑（已验证）
1. `OPENCLAW_IMAGE` 用 tag 会 crash loop；必须 `registry.fly.io/<app>@sha256:<64hex>`。
2. `TELEGRAM_ROUTER_WEBHOOK_URL` 缺失或空值，可能退化为 polling 或转发异常。
3. OpenClaw 冷启动慢通常不是卡死，是 jiti/V8 缓存构建叠加 `shared-cpu-1x` throttle。
4. TCP 端口通不代表 OpenClaw ready；应看 webhook/gateway 协议级探测日志。

## 冷启动优化（按优先级）
1. 创建期升配（`shared-cpu-2x` 或 `performance-1x`），ready 后降配。
2. 保留 volume，避免 destroy+create 导致 `/tmp` 缓存丢失后重编译。
3. 持久化缓存：
```bash
mkdir -p /app/data/cache/jiti /app/data/cache/node-compile-cache
ln -sfn /app/data/cache/jiti /tmp/jiti
export NODE_COMPILE_CACHE=/app/data/cache/node-compile-cache
```
4. 保持插件入口指向预编译 `index.js`。

## 标准排障命令（以 APIs 为准）
1. 看 Telegram 全链路日志：
```bash
flyctl logs -a pinclaw-api-dev -n | rg "inbound ts=|Forward failed|Forwarded successfully|Proxying Telegram API|Telegram API response"
```

2. 看某台 machine 冷启动与就绪：
```bash
flyctl logs -a pinclaw-api-dev -i <machine_id> -n | rg "pull|Machine started|TRP_VERSION|fetch proxy patch installed|Fully ready|telegram-webhook|ECONNRESET|502"
```

3. 检查关键 secrets：
```bash
flyctl secrets list -a pinclaw-api-dev | rg "TELEGRAM_ROUTER_WEBHOOK_URL|TELEGRAM_WEBHOOK_SECRET|OPENCLAW_IMAGE"
```

## 提交规范
- 使用 Conventional Commits：`feat(...)` / `fix(...)` / `chore(...)` / `docs(...)`。
- 每次提交聚焦一个变更点。
- 提交前最少跑：`npm run type-check`。

## 规则单一真源
- `AGENTS.md` 是 SSOT。
- `.cursor/rules/agents.mdc` 应软链接到本文件。
- `CLAUDE.md`、`GEMINI.md` 继续指向本文件，避免规则漂移。
