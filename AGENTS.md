# Repository Guidelines

## 编码原则

写代码和 review 时逐条对照。所有 AI coding 工具和团队成员共同遵守。

1. **先读后写** — 改代码前读懂现有实现的意图。不基于猜测写代码。
2. **用正解不绕过** — 找根因，不 workaround。禁止 `as any`、`@ts-ignore`、`eslint-disable`，除非注释说明为什么是唯一选项。
3. **改动最小化** — 只改该改的。不顺手重构，不加无关改善。
4. **用业界标准做法** — 业界有成熟 pattern 的功能直接用通用方案，不自己设计。同模块已有 pattern 就复用，不发明新写法。
5. **系统视角** — 改动前考虑在整个系统中的位置，接口变更考虑上下游，数据变更考虑迁移。
6. **边界防御，内部信任** — 系统边界做防御性处理，内部代码信任类型系统。
7. **高效** — 注意复杂度和不必要的 IO，但不为微优化牺牲可读性。
8. **低冗余不过度抽象** — 消除真正的重复。三行重复优于只用一次的抽象。
9. **关键路径可观测** — 状态变更和系统边界留日志，能定位问题即可。
10. **写完自审** — 实现完成后 review 完整 diff，对照以上原则检查，发现问题立即修。

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
- `DOTENV_PRIVATE_KEY_DEV` — deploy-dev workflow（构建 OpenClaw 镜像时更新 digest + 解密 .env.dev 提取 VITE_* build args）
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
- `proactive-ai/`：废弃目录，已合并到 `pinai-openclaw/plugins/proactive-ai/`
- `proactive-ai-frontend/src/`：React SPA 前端（Vite + Tailwind + Capacitor，支持 Web/iOS/Android）
- `ops/litellm/`：LiteLLM 配置与部署脚本

## 文档读取规则（AI 必读）
`docs/` 是团队开发和 AI agent 查询的统一上下文。读取顺序必须渐进式展开：

1. 先读 [`docs/index.mdx`](docs/index.mdx)，确认该任务属于哪个模块。
2. 再读相关的 `docs/modules/*.mdx`。模块文档是当前事实，改代码前以它为准。
3. 只有当模块文档底部出现 `相关 AI Plans`，或任务明确涉及对应设计取舍时，才继续读 `docs/plans/*.mdx`。
4. 不要把 `docs/plans/` 当历史归档。plan 只是可引用的 AI 设计计划，不替代模块文档。
5. 如果代码行为和文档冲突，以代码核实当前事实，并同步更新对应模块文档。

## 文档维护规则
- `docs/modules/*.mdx`：每个模块一篇当前事实文档，必须包含边界、核心链路、开发入口、验证方式、踩坑。
- `docs/plans/*.mdx`：只保留仍然能解释当前设计的 AI plans。除 `docs/plans/README.mdx` 外，每个 plan 必须被至少一个模块文档的 `相关 AI Plans` 引用。
- 新增 plan 的默认路径是 `docs/plans/YYYY-MM-DD-<topic>.mdx`；长期架构计划可以使用稳定 slug。
- plan 被模块文档完全吸收、过期或不再被引用时，删除它，不新建 archive。
- Mintlify 主导航只放 `docs/index.mdx` 和 `docs/modules/*.mdx`；plans 通过模块页渐进式访问。

## 当前模块文档
- [`docs/modules/data-connectors.mdx`](docs/modules/data-connectors.mdx) — Composio、device registry、mobile proxy、mobile ingest、连接状态矩阵。
- [`docs/modules/memory.mdx`](docs/modules/memory.mdx) — raw.db、personal_signals、world_signals、memory、profile、skill、evolution。**改动 memory / profile / skill / personal_signals / world_signals / evolution_runs / raw.db / skills folder 相关代码前必读**；需要 schema 和迁移细节时再读 [`docs/plans/memory-architecture.mdx`](docs/plans/memory-architecture.mdx)。
- [`docs/modules/generation.mdx`](docs/modules/generation.mdx) — `/generate`、pipeline、unified generator、evaluation、card selection、auto-generate。
- [`docs/modules/feedback.mdx`](docs/modules/feedback.mdx) — feedback events、card action、card chat feedback、intent state、学习回流。
- [`docs/modules/runtime-deployment.mdx`](docs/modules/runtime-deployment.mdx) — 本地启动、APIs proxy、container、gateway、LiteLLM、dotenvx、CI/CD、prod 规则、billing 概览。

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
- 改 `pinai-openclaw/` → 先构建镜像、更新 digest，再部署 APIs（同一 workflow 内 job 依赖，无竞态）
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

## Skill 管理规则（OpenClaw skills）

`pin / gws-* / openai-*-by-pinai` 这些 skill MD 是注入到用户容器、所有 OpenClaw agent（unified-generator / chat / dreaming）共用的指令文档。

**唯一允许的位置**：`pinai-openclaw/image/skills/<key>/SKILL.md`。
- Dockerfile L81 把这个目录拷到容器内 `/opt/pinai/skills/`。
- `apis/src/domain/container/providers/shared/openclaw_config.ts` 把 `/opt/pinai/skills` 注入到 `extraDirs`，OpenClaw runtime 启动时扫描这里加载所有 skill。
- 不要把 SKILL.md 放在 plugin 自己的 `skills/` 子目录里——OpenClaw runtime 不扫那里（不在 extraDirs 里），文件等于 dead docs。

**新增 skill 的步骤**：
1. 建 `pinai-openclaw/image/skills/<key>/SKILL.md`，frontmatter 至少含 `name / version / description`。
2. 跑 `node scripts/sync-skills-manifest.mjs` 重新生成 `apis/src/domain/skills/generated_custom_skill_keys.ts`。
3. 在 `apis/src/domain/skills/openclaw_skills.ts` 的 `DEFAULT_SKILLS_CATALOG` 加一条 `{ key, name, description }`（前端展示用）。
4. 重新 build openclaw 镜像（本地 `make build-openclaw-local`，dev 走 CI 自动）。

**SKILL.md 同时要被 plugin 代码拼到 prompt 里时**（如 `pin-cli-command-guide.ts`）：
- 用 `fs.readFileSync` 读，不要把 MD 内容复制到 TS 常量——会立刻漂移。
- 路径 candidate 先容器再 dev：`/opt/pinai/skills/<key>/SKILL.md` → `<repo>/pinai-openclaw/image/skills/<key>/SKILL.md`。`existsSync` 选第一个存在的。
- 范例：`pinai-openclaw/plugins/proactive-ai/agents/pin-cli-command-guide.ts`。

**MD 内容规则**：
- 一个 skill 一篇 MD，不要拆 `pin-shared` / `pin-memory` 这种"前置依赖" sub-skill——agent 不会自动跟随引用，那只是文本，徒增维护成本。
- 时间过滤用 ISO 时间戳（`2026-04-21T00:00:00Z`），不要写 `--since 14d` 这种相对量——DB 层是直接 `created_at >= ?` SQL 字符串比较，`'14d'` 比任何 ISO 都小，过滤等于不过滤。
- **增量消费优于固定时间窗**。卡片生成 / dreaming 读 feedback / cards 时，先 `pin evolution recent --kind manual --status completed --limit 1` 拿上次成功 run 的 `started_at`，把它作为 `--since` 锚点；首次或拿不到锚点就只用 `--limit`。signals 永远默认 `--status open`（CLI 已经 filter 未消费过的）。raw 用 `--hours N` 控近端窗口，N 按用途选。

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
