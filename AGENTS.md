# Repository Guidelines

## 当前架构（一句话）
Telegram Router 已并入 `apis`，不存在独立 `telegram-router` 服务。所有 Telegram 入/出站统一走 `pinclaw-api-dev`。

## 环境拓扑（2026-03-05）
- Dev（当前生效）：
  - APIs：`pinclaw-api-dev`
  - Assistant 机器：`pinclaw-assistant-dev`（由 APIs 通过 `FLY_ASSISTANT_APP_NAME` 创建）
  - LiteLLM：`pinclaw-litellm-dev`
- Prod（规则口径）：
  - 禁止在终端直接 `flyctl`/DB 变更，必须走评审 + CI/CD。
  - Assistant 机器应与 APIs 隔离到独立 app（不要与 APIs 共用 app）。

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

## 本地测试手册（Checkpoint）
目标：本地完整验证 Telegram -> APIs -> Assistant -> Google OAuth/GWS 链路，且不影响 dev/prod。

0. 硬约束（先确认）
- 只在本地 worktree 运行（例如 `~/.config/superpowers/worktrees/...`），不要在主工作目录直接做实验。
- 严禁在本地测试过程中执行任何 prod `flyctl` 或 prod DB 变更命令。
- 本地 `nodeEnv` 必须不是 `production`。
- 当前仓库的私有本地模板固定路径：`~/.config/pinai/repos/pin-ai-assistant.env`
- 当前 worktree 的运行时 env 文件固定使用仓库根 `.env.local`

1. 启动前检查
- 本地 PostgreSQL 可用（建议本地容器独立端口，例如 `127.0.0.1:55432`）。
- 已执行 `npm install`（`local:doctor` 会检查依赖是否已安装）。
- 仓库根 `.env.local` 至少包含：
  - `SUPABASE_DB_URL`（本地库）
  - `TELEGRAM_BOT_TOKEN`（测试 bot）
  - `TELEGRAM_WEBHOOK_SECRET`
  - `TELEGRAM_BOT_USERNAME`
  - `ANTHROPIC_API_KEY`（避免 reset 后 assistant 首次回复报 key 缺失）
  - `TELEGRAM_ROUTER_WEBHOOK_URL`（你的 ngrok `https://.../webhook/telegram`）
- ngrok 已启动并指向本地 `apis` 端口（默认 `3001`）。
- 可先执行：
  - `npm run local:init-env`
  - `npm run local:doctor`
  - `npm run local:up`

2. 启动服务与健康检查
- 一键启动：`npm run local:up`
- 手动启动：`npm run dev`
- 健康检查：
  - `curl -sf http://127.0.0.1:3001/health`
  - `curl -skf https://<your-ngrok-domain>/health`
- 若 webhook 失联，先查 `getWebhookInfo`，确认 `last_error_message` 不是 `502/connection refused`。

3. 从零重测（建议每次改动后都跑）
- 在 TG 先执行 `/reset_account`，确认收到 reset 完成消息。
- 执行 `/start` -> `/create_claw_assistant`。
- 只有收到 `Your assistant is ready` 后再发业务消息；若未 ready，不做功能判定。
- 先发 `hi` 验证模型链路，再测邮件场景：
  - `给我看最近 10 封邮件`

4. Google OAuth / GWS 测试检查点
- 未授权时，机器人应返回授权入口（`/google/manage?telegram_user_id=...`），不是泛化“我不会”回答。
- 授权完成后，回调应写入 DB，并自动尝试下发凭据到容器。
- 下发失败时，必须返回明确错误（例如找不到 runtime_ref），不能静默成功。
- 成功后再次请求邮件，应返回真实 `From/Subject`，不是全 `(无主题)/(未知发件人)`。

5. 容器与凭据检查点
- 容器存在且 running：`docker ps | rg assistant-<telegram_user_id>`
- 容器内必须存在：
  - `/app/data/agents/main/agent/auth-profiles.json`（anthropic profile 正确）
  - `/app/data/google/gws-credentials.json`（授权后）
- 若 `reset_account` 后再次报 `No API key found for provider "anthropic"`：
  - 优先检查当前 worktree 根目录的 `.env.local` 是否有 `ANTHROPIC_API_KEY`；
  - 再检查容器创建时自动注入逻辑是否生效。

6. 验收通过标准（最小集）
- `hi` 稳定可回复，不出现 `temporarily unavailable` 或 provider key 缺失。
- 邮件请求在未授权/已授权两种状态下行为都正确。
- 冷启动期间不会提前发送“ready”误导消息（ready 后立即可聊）。
- 全流程不依赖改动 dev/prod 资源。

7. 30 秒快速自检（可直接复制）
```bash
# 0) 初次进入新 worktree
npm install
npm run local:init-env

# 1) APIs / ngrok 健康
curl -sf http://127.0.0.1:3001/health && echo " local health ok"
curl -skf https://<your-ngrok-domain>/health && echo " ngrok health ok"

# 2) 关键本地进程
ps aux | rg "npm run dev|tsx.*apis|ngrok" -n

# 3) assistant 容器是否存在（替换 TG 用户 ID）
docker ps | rg "assistant-<telegram_user_id>"

# 4) 容器内关键凭据文件（替换容器名）
docker exec assistant-<telegram_user_id> sh -lc "ls -l /app/data/agents/main/agent/auth-profiles.json /app/data/google/gws-credentials.json"

# 5) 最近错误关键字（本地 APIs 日志窗口内观察）
# No API key found for provider \"anthropic\"
# temporarily unavailable
# Forward failed on all candidate endpoints
```

## Feature 开发标准流程
目标：从最新 `dev` 新开 feature，到本地验证通过，再进入 PR，不依赖记忆。

1. 同步最新 `dev`
- `git fetch origin`
- `git switch dev`
- `git pull --ff-only origin dev`

2. 新开 worktree
- `git worktree add ~/.config/superpowers/worktrees/PIN-AI-ASSISTANT/<branch-name> origin/dev -b <branch-name>`
- `cd ~/.config/superpowers/worktrees/PIN-AI-ASSISTANT/<branch-name>`

3. 初始化本地环境
- `npm install`
- `npm run local:init-env`
- `npm run local:doctor`
- `npm run local:up`

4. 做基线验证
- `curl -sf http://127.0.0.1:3001/health`
- 若这里就失败，先修环境，不要把环境问题误判成代码问题。

5. 开发与本地回归
- 小步改动，小步验证。
- 至少跑一遍本地主链路：`/reset_account` -> `/start` -> `/create_claw_assistant` -> `hi` -> 业务消息。

6. PR 前收口
- `git fetch origin && git rebase origin/dev`
- `npm run type-check`
- `npm run test --workspace @pin-ai/apis`
- 手工回归主链路
- `git diff origin/dev...HEAD` 检查是否误带本地调试内容、ngrok 地址、私有 env
- 再提交和开 PR

## 变更决策表（先看这个）
1. 改 `apis/` 代码：
- 直接提交并 `git push`，GitHub Actions 自动部署 `pinclaw-api-dev`。

2. 改 `openclaw-plugins/` 或 OpenClaw 启动行为：
- 必须重建并推送 OpenClaw 镜像；
- 然后更新 `OPENCLAW_IMAGE`（必须 `@sha256:` 格式）。
- 备注：插件改动不会随 APIs 部署自动进入用户容器，必须走镜像 digest 更新。

3. 只改文档：
- `docs/` 默认被忽略，提交时需要 `git add -f docs/<file>`。

## 生产环境硬性规则（必须遵守）
- 生产环境（`pinclaw-api-prod`、`pinclaw-litellm-prod`）禁止直接执行任何 `flyctl` 命令。
- 生产环境禁止直接执行任何数据库变更（含手动 SQL、`migrate`、`db push`、`schema` 变更）。
- 所有生产变更必须走代码评审 + CI/CD 发布流程，不允许在终端临时“热修”。

## Prod 上线同类工作清单（安全版）
1. 合并前（代码侧）
- 确认 P0 防护仍在：`assertNoP0SecretsInEnv` / `assertNoP0SecretsInConfig` 未被绕过。
- 若改了 `openclaw-plugins/` 或启动命令：同步重建 OpenClaw 镜像并准备新 `OPENCLAW_IMAGE@sha256`。
- 至少通过：`npm run type-check`、`npm run test --workspace @pin-ai/apis`。

2. 发布前（配置侧）
- 确认 prod 也使用 assistant 独立 app（`FLY_ASSISTANT_APP_NAME` 指向 prod assistant app）。
- 确认 `OPENCLAW_IMAGE` 为 digest（禁止 tag）。
- 确认 Telegram 路由关键项完整：`TELEGRAM_ROUTER_WEBHOOK_URL`、`TELEGRAM_WEBHOOK_SECRET`。

3. 发布后（验收侧）
- 看 APIs 日志：无 `Forward failed on all candidate endpoints`。
- 看 assistant 日志：出现 `webhook local listener` 后再出现用户业务消息转发。
- 抽检一台 assistant 机：P0 三项不在 env / openclaw config 明文中。

4. 回滚策略
- 优先回滚应用版本与 `OPENCLAW_IMAGE` digest（均走 CI/CD）。
- 回滚后重复“发布后验收侧”三步，确认链路和密钥防护同时恢复。

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
  - `FLY_ASSISTANT_APP_NAME`（dev 当前应为 `pinclaw-assistant-dev`）
- OpenClaw machine env：
  - `TELEGRAM_ROUTER_URL`（应指向 APIs）
  - `OPENCLAW_TELEGRAM_WEBHOOK_PATH`
  - `OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH`
  - `NODE_COMPILE_CACHE`

## 泄露机制与防护（P0）
- P0（平台级）：
  - `telegram.token`（`TELEGRAM_BOT_TOKEN`）
  - `telegram.webhookSecret`（`TELEGRAM_WEBHOOK_SECRET`）
  - `elevenlabs.apiKey`（`ELEVENLABS_API_KEY` / `XI_API_KEY`）
- 已落地防护：
  - 用户容器禁止注入上述 P0 key/value（env + OpenClaw config 双层防护）。
  - QuickStart 使用 synthetic bot token（`0:...`）+ assistant 级派生 webhook secret，不下发平台真实 token/secret。
  - OpenClaw 启动不再把完整配置 JSON 内联在 `init.exec` 命令；改为 `OPENCLAW_CONFIG_B64` 容器内解码，避免 Fly `Preparing to run` 日志明文泄露。
  - Assistant 机器与 APIs 分 app 运行，避免平台 secrets 被动注入到用户容器。
- 验证口径（每次改动后至少抽查一次）：
  - assistant 机内 `printenv` 不得出现上述 P0 非空值。
  - `/app/data/config/openclaw.json` 不得出现上述 P0 key。

## 实战踩坑（已验证）
1. `OPENCLAW_IMAGE` 用 tag 会 crash loop；必须 `registry.fly.io/<app>@sha256:<64hex>`。
2. `TELEGRAM_ROUTER_WEBHOOK_URL` 缺失或空值，可能退化为 polling 或转发异常。
3. OpenClaw 冷启动慢通常不是卡死，是 jiti/V8 缓存构建叠加 `shared-cpu-1x` throttle。
4. TCP 端口通不代表 OpenClaw ready；应看 webhook/gateway 协议级探测日志。
5. `container_status=running` 不等于 Telegram 可用；必须等待 webhook HTTP 真正可响应后再通知 ready。

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
flyctl logs -a pinclaw-assistant-dev -i <machine_id> -n | rg "pull|Machine started|TRP_VERSION|fetch proxy patch installed|Fully ready|telegram-webhook|ECONNRESET|502|webhook local listener"
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

# 规则
1. 每次压缩上下文后，请重新读取任务计划和相关文件，确定好任务 scope 不偏离。
