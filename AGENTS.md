# Repository Guidelines

## 编码原则

写代码和 review 时逐条对照。所有 AI coding 工具和团队成员共同遵守。

1. **先读后写** — 修改前读完相关函数、调用方和测试。不读就写等于猜。
2. **根因修复** — 报错在 A 不代表 bug 在 A。trace 到真正出错的位置再改。禁止 `as any`、`@ts-ignore`、`eslint-disable` 绕过，除非注释说明为什么是唯一选项。
3. **最小 diff** — 只改需求涉及的代码。不改命名风格、不加注释、不调格式、不"顺手优化"。
4. **用业界标准做法** — 业界有成熟 pattern 的功能（认证、分页、重试、队列等）直接用通用方案，不自己设计。同模块已有 pattern 就复用，不发明新写法。
5. **上下游感知** — 改函数签名前 grep 所有调用方。改 API 响应结构前确认前端消费方。改 DB schema 走 migration。
6. **边界校验，内部信任** — 用户输入、外部 API 响应、环境变量在入口校验一次。校验通过后内部传递信任类型，不重复检查。
7. **O(n) 警觉** — 循环内避免数据库查询和网络请求。大集合操作注意是否可以批量。不为常数级差异做微优化。
8. **重复三次再抽象** — 两处相似不提取。三处以上且变化点明确时才抽函数。单次使用的 helper 直接内联。
9. **错误可追踪** — 抛错和日志必须包含足以定位问题的上下文（哪个用户、哪个请求、什么输入）。不 `catch (e) { throw new Error('failed') }` 吞掉原始信息。
10. **提交前自审 diff** — `git diff` 逐行过，确认：无调试代码残留、无意外文件、无超出需求的改动。

## 只读源码参考
- `pinai-openclaw/external/openclaw/`：OpenClaw 上游源码（git submodule）。**仅供阅读参考，禁止修改此目录下的任何文件。**

## 当前架构
Proactive AI 是产品主线。用户通过 proactive-ai-frontend（React SPA，Supabase Auth 登录）使用产品，APIs 负责容器编排与 gateway 代理，每个用户对应一台 OpenClaw assistant 机器（运行 pinai-openclaw 镜像），机器内跑 proactive-ai 插件（pipeline / scheduler / agents / world）。

LiteLLM 作为 LLM 路由代理，统一管理模型调用（Claude、GPT、ElevenLabs TTS 等）。

## 环境拓扑

| 环境 | APIs | Assistant Machines | LiteLLM | OpenClaw Registry |
|------|------|--------------------|---------|-------------------|
| dev | `proactive-ai-api-dev` | `proactive-ai-assistant-dev` | `proactive-ai-litellm-dev` | `proactive-ai-openclaw`（共用） |
| prod | `proactive-ai-api-prod` | `proactive-ai-assistant-prod` | `proactive-ai-litellm-prod` | `proactive-ai-openclaw`（共用） |

OpenClaw 镜像 registry 只有一个，dev 和 prod 通过 digest 区分版本。

## Secrets 管理（dotenvx）
所有环境变量（后端 secrets + 前端 VITE_*）统一用 [dotenvx](https://dotenvx.com/) 加密后 checkin 到 git。每个环境一把私钥。

```
apis/.env.dev          # dev 所有变量（加密，已 checkin，含 VITE_*）
apis/.env.production   # prod 所有变量（加密，已 checkin，含 VITE_*）
apis/.env.keys         # 私钥（不 checkin，找团队成员获取）
ops/litellm/.env.dev / .env.production / .env.keys  # 同上
```

本地明文 `.env` 由 `make ensure-env` 自动从加密文件解密生成，不 checkin：
- `apis/.env` — docker-compose runtime 读取
- `ops/litellm/.env` — docker-compose runtime 读取
- 前端 VITE_* 在 `make up` 时自动从加密文件提取，通过 docker-compose build args 注入

常用操作：
```bash
npx dotenvx get -f apis/.env.dev                          # 查看所有 key 明文
npx dotenvx set NEW_KEY "value" -f apis/.env.dev           # 加/改 key
npx dotenvx run -f apis/.env.dev -- node dist/src/server.js  # 解密运行
make env-local                                             # 强制重新解密所有 .env
```

Fly.io 上每个 app 只需设一个 secret（私钥），容器启动时自动解密：
```bash
flyctl secrets set DOTENV_PRIVATE_KEY_DEV="..." -a proactive-ai-api-dev
```

CI 需要在 GitHub Secrets 设置以下 secrets：
- `FLY_API_TOKEN` — 所有 deploy workflow
- `DOTENV_PRIVATE_KEY_DEV` — build-openclaw workflow（更新 OPENCLAW_IMAGE digest + deploy）
- `DOTENV_PRIVATE_KEY_DEV` — deploy-dev + build-openclaw workflow（解密 .env.dev，提取 VITE_* build args）
- `DOTENV_PRIVATE_KEY_PRODUCTION` — deploy-prod workflow（解密 .env.production，提取 VITE_* build args）

## 高频目录
- `apis/src/server.ts`：服务入口
- `apis/src/controller/`：HTTP 路由（dashboard、proactive、payment、VNC、container 等）
- `apis/src/domain/proactive/`：Proactive AI 后端（Supabase auth、容器编排、gateway 代理、LiteLLM key）
- `apis/src/domain/gateway/`：WebSocket relay、session 管理、RPC
- `apis/src/domain/container/`：容器创建/销毁、idle suspend、状态同步（Docker + Fly 双 provider）
- `apis/src/domain/payment/`：Stripe 集成、订阅、计费
- `apis/src/domain/common/`：共享配置、DB repositories、infra runtime
- `pinai-openclaw/plugins/proactive-ai/`：Proactive AI 核心插件（pipeline、scheduler、agents、world、CLI）
- `pinai-openclaw/image/`：OpenClaw 自定义镜像（Dockerfile、entrypoint、warmup、skills）
- `proactive-ai-frontend/src/`：React SPA 前端（Vite + Tailwind + Capacitor，支持 Web/iOS/Android）
- `ops/litellm/`：LiteLLM 配置与部署脚本

## 本地开发
首次设置：
```bash
npm install
# 找团队成员获取 .env.keys
# 放到 apis/.env.keys 和 ops/litellm/.env.keys
make up      # 自动解密 .env.dev → .env，构建并启动所有服务
```

全栈启动（Docker Compose）：
```bash
make up          # 构建并启动所有服务（postgres + litellm + apis + openclaw）
make logs        # 查看日志
make restart     # 改了 apis/ 代码后重建重启
make reset       # 清空数据从头来（数据会丢失）
make status      # 查看容器状态
```

轻量开发（不走 Docker）：
```bash
npm run dev                                   # APIs dev server
cd proactive-ai-frontend && npm run dev       # 前端 dev server（端口 3003）
```

验证：
```bash
npm run type-check
npm run test --workspace @pin-ai/apis
```

完整命令：`make help`

## 变更与部署

### Dev 环境（自动）
push 到 `proactive-ai-v2` 后根据改动范围自动部署，不需要手动操作：
- 改 `apis/` 或 `proactive-ai-frontend/` → 自动部署 APIs
- 改 `pinai-openclaw/` → 自动构建镜像、更新 OPENCLAW_IMAGE digest、部署 APIs
- 改 `ops/litellm/` → 自动部署 LiteLLM

### Prod 环境（手动触发）
在 GitHub Actions 页面手动触发 **Deploy Prod**，或 push `v*` tag：
- 自动 promote OPENCLAW_IMAGE digest（从 .env.dev → .env.production，同一镜像不重新构建）
- 部署 APIs + 前端 + LiteLLM

### 本地部署（备用）
CI/CD 不可用时可以本地直接部署：
```bash
make deploy-dev           # APIs dev
make deploy-prod          # APIs prod（有 3 秒确认）
make deploy-litellm-dev   # LiteLLM dev
make deploy-litellm-prod  # LiteLLM prod
make build-openclaw-image # 构建 OpenClaw 镜像到共用 registry
```

## 生产环境硬性规则
- 生产部署优先走 GitHub Actions（有审计日志和 approval）。
- 生产环境禁止直接执行任何数据库变更。
- 所有生产变更必须走代码评审 + CI/CD。

## 安全约束（P0）
- P0 密钥（`TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`ELEVENLABS_API_KEY`）禁止注入用户容器。
- 防护机制：`assertNoP0SecretsInEnv` / `assertNoP0SecretsInConfig`（见 `apis/src/domain/container/providers/shared/secret_guard.ts`），改动容器相关代码后必须确认未被绕过。
- OpenClaw 配置走 `OPENCLAW_CONFIG_B64` 容器内解码，避免 Fly 日志明文泄露。
- dotenvx 私钥（`.env.keys`）禁止 checkin，找团队成员获取。

## 踩坑速查
1. `OPENCLAW_IMAGE` 用 tag 会 crash loop；必须 `registry.fly.io/proactive-ai-openclaw@sha256:<64hex>`。
2. OpenClaw 冷启动慢不是卡死，是 jiti/V8 缓存构建叠加 `shared-cpu-1x` throttle。
3. `container_status=running` 不等于服务可用；必须等 HTTP 探测通过。
4. 本机全局代理会导致 `flyctl` 和 Docker push 失败，deploy 命令已内置 `env -u` 处理。

## 数据库变更规则
- 每次 schema 变更写新的 migration 文件到 `apis/db/migrations/`。
- migration 文件一旦 merge 到 main，禁止修改。
- migration 只做 additive（加表、加列）；删列/改列走 expand-contract，分两个 release。
- dev/prod migration 均随部署自动执行（`fly.toml` 的 `release_command` → `run-all-migrations.mjs`），禁止手动连 prod DB 跑 SQL。

## 提交规范
- Conventional Commits：`feat(...)` / `fix(...)` / `chore(...)` / `docs(...)`。
- 每次提交聚焦一个变更点。
- 提交前最少跑：`npm run type-check`。

## 规则单一真源
- `AGENTS.md` 是 SSOT。
- `CLAUDE.md`、`GEMINI.md`、`.cursor/rules/agents.mdc` 均指向本文件。
- 未经允许不要乱加 fallback。
- 请使用平实、直接、克制的技术白话中文。禁止大厂黑话（赋能、闭环、底座、抓手等）。多用精确工程术语，从具体事实说起。
