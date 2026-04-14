# Proactive AI 运维指南

给团队成员的快速参考，覆盖本地开发、secrets 管理和 CI/CD 流程。

---

## 1. 本地开发

### 首次设置

```bash
npm install
# 找团队成员获取 .env.keys，放到：
#   apis/.env.keys
#   ops/litellm/.env.keys
make up      # 自动解密 .env -> 构建并启动所有服务
```

### 全栈启动（Docker Compose）

```bash
make up          # postgres + litellm + apis + openclaw
make logs        # 查看日志
make restart     # 改了 apis/ 代码后重建重启
make reset       # 清空数据从头来（数据会丢失）
make status      # 查看容器状态
```

### 轻量开发（不走 Docker）

```bash
npm run dev                                   # APIs（端口 3000）
cd proactive-ai-frontend && npm run dev       # 前端（端口 3003）
```

### 验证

```bash
npm run type-check
npm run test --workspace @pin-ai/apis
```

### Supabase 说明

本地开发连的是 **dev Supabase 项目**。OAuth 登录回调通过 Supabase Dashboard 的 Redirect URLs 白名单控制：

- Site URL：`https://proactive-ai-api-dev.fly.dev/proactive/`
- 白名单包含 `http://localhost:3003/proactive/` 等本地地址

本地和 dev 环境互不影响，各自的 `window.location.origin` 会匹配到对应的白名单条目。

---

## 2. Secrets 管理（dotenvx）

所有环境变量用 [dotenvx](https://dotenvx.com/) 加密后 checkin 到 git。每个环境一把私钥。

### 文件结构

```
apis/.env.dev          # dev 环境变量（加密，已 checkin）
apis/.env.production   # prod 环境变量（加密，已 checkin）
apis/.env.keys         # 私钥（不 checkin，找团队成员获取）
ops/litellm/.env.dev / .env.production / .env.keys  # 同上
```

### 常用操作

```bash
# 查看某个 key 明文
npx @dotenvx/dotenvx get FLY_API_TOKEN -f apis/.env.dev

# 查看所有 key 明文
npx @dotenvx/dotenvx get -f apis/.env.dev

# 加/改 key（自动加密写入）
npx @dotenvx/dotenvx set NEW_KEY "value" -f apis/.env.dev

# 解密运行
npx @dotenvx/dotenvx run -f apis/.env.dev -- node dist/src/server.js
```

### 运行时解密

容器内不存在明文 `.env`。Dockerfile 拷入加密文件，启动时通过 dotenvx 解密：

```
CMD dotenvx run -f .env.${DEPLOY_ENV} -- node dist/src/server.js
```

解密所需的私钥通过 Fly secret 注入：

```bash
flyctl secrets set DOTENV_PRIVATE_KEY_PRODUCTION="..." -a proactive-ai-api-prod
```

### 前端 VITE_* 变量

VITE_* 在 Docker 构建阶段从加密文件提取，作为 build arg 注入 Vite 构建，bake 到 JS bundle 里。不走运行时解密。

---

## 3. Fly.io Apps

| 环境 | APIs | Assistant Machines | LiteLLM | OpenClaw Registry |
|------|------|--------------------|---------|-------------------|
| dev | `proactive-ai-api-dev` | `proactive-ai-assistant-dev` | `proactive-ai-litellm-dev` | `proactive-ai-openclaw`（共用） |
| prod | `proactive-ai-api-prod` | `proactive-ai-assistant-prod` | `proactive-ai-litellm-prod` | `proactive-ai-openclaw`（共用） |

每个 app 需要设置的 Fly secret：`DOTENV_PRIVATE_KEY_DEV` 或 `DOTENV_PRIVATE_KEY_PRODUCTION`。

---

## 4. CI/CD

### 流水线一览

| Workflow | 触发条件 | 做什么 |
|----------|----------|--------|
| **ci.yml** | PR -> `proactive-ai-v2` | TypeScript type-check |
| **deploy-dev.yml** | push `proactive-ai-v2`（改 `apis/` 或 `proactive-ai-frontend/`） | 提取 VITE_* -> deploy APIs to dev |
| **build-openclaw.yml** | push `proactive-ai-v2`（改 `pinai-openclaw/`）或手动 | 构建镜像 -> 更新 digest -> deploy dev |
| **deploy-litellm.yml** | push `proactive-ai-v2`（改 `ops/litellm/`）或手动 | deploy LiteLLM（dev/prod 可选） |
| **deploy-prod.yml** | 手动触发 或 push `v*` tag | deploy APIs + LiteLLM to prod |

### GitHub Secrets 需要设置

| Secret | 用途 |
|--------|------|
| `FLY_API_TOKEN` | 所有 deploy workflow 的 flyctl 认证 |
| `DOTENV_PRIVATE_KEY_DEV` | 解密 `.env.dev`（提取 VITE_* build args） |
| `DOTENV_PRIVATE_KEY_PRODUCTION` | 解密 `.env.production`（提取 VITE_* build args） |

### Dev 部署（自动）

push 到 `proactive-ai-v2` 后根据改动范围自动部署，无需手动操作。

### Prod 部署（手动）

在 GitHub Actions 页面手动触发 **Deploy Prod**，或打 tag：

```bash
git tag v1.x.x && git push origin v1.x.x
```

### 认证机制

- **CI/CD 阶段**：`FLY_API_TOKEN`（GitHub Secret）驱动 `flyctl deploy` 推镜像
- **容器运行时**：`FLY_API_TOKEN`（加密在 `.env.dev` / `.env.production` 中）用于 registry 验证和 machine 管理

两个 token 用途不同，互不干扰。

---

## 5. 本地部署（CI 不可用时备用）

```bash
make deploy-dev           # APIs dev
make deploy-prod          # APIs prod（有 3 秒确认）
make deploy-litellm-dev   # LiteLLM dev
make deploy-litellm-prod  # LiteLLM prod
make build-openclaw-image # 构建 OpenClaw 镜像
```
