# Repository Guidelines

## 项目结构与模块组织
本仓库以 `apis/` 为核心（Node + TypeScript 后端），辅以插件与运维模块。
- `apis/src/controller/`：HTTP/WS 路由入口。
- `apis/src/domain/`：业务域（`auth`、`payment`、`telegram-bot`、`telegram-router`、`container` 等）。
- `apis/db/migrations/`：按序执行的数据库迁移 SQL。
- `openclaw-plugins/telegram-router-proxy/`：OpenClaw 出站 Telegram API 代理插件。
- `infra/container-manager/images/openclaw/`：OpenClaw 自定义镜像构建。
- `ops/litellm/`：LiteLLM 启停脚本与部署配置。
- `docs/`：架构、产品和运维文档（默认被 `.gitignore` 忽略）。

新增功能优先放在 `apis/src/domain/<feature>/`，路由层仅做参数校验与调用编排。

## 构建、测试与开发命令
在仓库根目录执行：
- `npm install`：安装依赖。
- `npm run dev`：启动 `@pin-ai/apis` 开发服务。
- `npm run build`：编译 API 到 `apis/dist/`。
- `npm run start`：运行编译产物。
- `npm run type-check`：严格 TypeScript 类型检查。
- `npm run test --workspace @pin-ai/apis`：运行 `*.test.ts` 测试。
- `npm run litellm:up` / `npm run litellm:logs`：管理本地 LiteLLM。

## 代码风格与命名规范
- 使用 TypeScript ESM（`NodeNext`），保持 `strict` 通过。
- 缩进 2 空格；保持函数短小、职责单一。
- 命名约定：变量/函数 `camelCase`，类型/类 `PascalCase`。
- 路由层保持薄，业务逻辑下沉到 `domain`。
- 仓库未统一 ESLint/Prettier 配置，提交前至少执行 `npm run type-check`。

## 测试规范
- 主测试方式：`tsx --test`（位于 `apis` 工作区）。
- 测试文件命名：`*.test.ts`，建议与被测模块就近放置。
- 新增逻辑至少覆盖：主流程、关键失败分支、回归路径。
- Telegram 路由联调以 APIs 日志为准，不再使用独立 `telegram-router` 测试脚本。

## 提交与 PR 规范
- 遵循 Conventional Commits：如 `feat(telegram): ...`、`fix(litellm): ...`。
- 每次提交聚焦单一变更点；PR 说明需包含背景、改动、验证步骤、配置/迁移影响。
- 若涉及页面或机器人流程变更，附关键日志、请求示例或截图。

## 代理规则单一真源
- `AGENTS.md` 为规则单一真源（SSOT）。
- 新版 Cursor 规则入口使用 `.cursor/rules/agents.mdc`，并应软链接到 `AGENTS.md`。
- `CLAUDE.md`、`GEMINI.md` 保持指向 `AGENTS.md`，兼容不同工具与版本，减少规则漂移。

## 部署排障记录
### Fly.io：depot builder 握手 EOF
现象：
- `flyctl deploy` 在构建阶段失败，常见报错：
- `error releasing builder: deadline exceeded`
- `failed to list workers: Unavailable: connection error: desc = "transport: authentication handshake failed: EOF"`

结论：
- 通常不是 `fly.toml` 配置问题，而是 `depot builder` 链路异常。
- 使用 Fly 远程构建并绕过 depot（`--depot=false`）通常可恢复部署。
- 本地代理（如 `http_proxy/https_proxy/all_proxy=127.0.0.1:7890`）可能提高 depot 的 gRPC/TLS 握手失败概率。

推荐命令（手动调试部署 APIs 时）：
```bash
flyctl deploy . -a pinclaw-api-dev --config .fly-api-debug.toml --remote-only --depot=false
```

如果必须使用 depot，先在无代理环境测试：
```bash
env -u all_proxy -u ALL_PROXY -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u no_proxy -u NO_PROXY \
flyctl deploy . -a pinclaw-api-dev --config .fly-api-debug.toml --remote-only --depot=true
```

## Telegram Router 架构与部署（已并入 APIs）

### 架构概览
Telegram Router 不再是独立 Bun 服务，已并入 APIs。

消息流：
```text
Telegram API → APIs(/webhook/telegram*) → OpenClaw 容器
OpenClaw 容器 → telegram-router-proxy 插件 → APIs(/api/telegram/:method) → Telegram API
```

### 关键组件
| 组件 | 路径 | 运行时 | 部署目标 |
|------|------|--------|----------|
| Telegram Router 路由 | `apis/src/domain/telegram-router/` | Node | `pinclaw-api-dev` |
| OpenClaw 代理插件 | `openclaw-plugins/telegram-router-proxy/` | Node (OpenClaw 内) | 内置于 OpenClaw 镜像 |
| APIs 容器编排 | `apis/src/domain/container/` | Node | `pinclaw-api-dev` |

### 部署流程
#### 1. OpenClaw 镜像（含 telegram-router-proxy 插件）
采用「薄层自定义镜像」方案：`infra/container-manager/images/openclaw/Dockerfile` 基于官方 OpenClaw 镜像，COPY 插件源码到 `/opt/pinai/plugins/`。

构建并推送到 Fly registry：
```bash
cat > .fly-openclaw-build.toml << 'EOF2'
app = 'pinclaw-api-dev'
[build]
  dockerfile = 'infra/container-manager/images/openclaw/Dockerfile'
EOF2

flyctl deploy . \
  --config .fly-openclaw-build.toml \
  --build-only --push \
  --image-label openclaw-with-plugin \
  --remote-only --depot=false

rm -f .fly-openclaw-build.toml
```

**注意**：`--build-only` 不会自动推送镜像，必须加 `--push` 参数。

更新 APIs 服务指向新镜像（必须使用 `@sha256:` digest 格式，tag 格式会导致启动失败）：
```bash
flyctl secrets set \
  OPENCLAW_IMAGE=registry.fly.io/pinclaw-api-dev@sha256:<从构建输出获取> \
  -a pinclaw-api-dev
```

#### 2. APIs 服务
APIs 代码变更通过 **Git push → GitHub Actions** 自动部署到 `pinclaw-api-dev`，通常无需手动 `flyctl deploy`。

### 部署触发规则（实践约定）
- `apis/` 目录改动：直接 `git push` 即可，CI 会自动触发 APIs 部署。
- `openclaw-plugins/` 或 OpenClaw 镜像相关改动：必须先构建并推送新镜像（拿到 `@sha256:` digest），再更新 `OPENCLAW_IMAGE`。
- 需要验证 Fly 构建或部署问题时，优先使用 `flyctl` 命令排障。

### 环境变量与 Secrets
#### pinclaw-api-dev (Fly secrets)
- `OPENCLAW_IMAGE` — OpenClaw 镜像 digest（**必须** `@sha256:` 格式）
- `TELEGRAM_ROUTER_WEBHOOK_URL` — Telegram webhook 对外入口（建议指向 APIs）
- `OPENCLAW_TELEGRAM_WEBHOOK_PATH` — OpenClaw 容器内 webhook 路径
- `TELEGRAM_WEBHOOK_SECRET` — Webhook 密钥

#### OpenClaw machine env（运行期）
- `TELEGRAM_ROUTER_URL` — Telegram API 代理入口（应指向 APIs）
- `OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH` — 插件路径（默认 `/opt/pinai/plugins/telegram-router-proxy`）
- `NODE_COMPILE_CACHE` — Node 编译缓存路径（建议挂载到 volume）

### 排障要点
- APIs 的 `image_digest_guard.ts` 在启动时校验 `OPENCLAW_IMAGE` 必须是 `registry.fly.io/<app>@sha256:<64-hex>` 格式，tag 格式（如 `:openclaw-with-plugin`）会导致 crash loop。
- 如果 APIs 机器因 crash loop 达到最大重启次数而停止，修复 secret 后需手动 `flyctl machines start <id> -a pinclaw-api-dev`。
- OpenClaw 代理插件有方法黑名单（如 `setWebhook`、`getUpdates`），这类调用不会走正常代理发送。

## OpenClaw 容器冷启动性能

### 瓶颈与优化
OpenClaw 在 `shared-cpu-1x` 上冷启动慢的两大原因：

1. **jiti 编译**：OpenClaw 内部使用 jiti（JIT TS→JS 编译器）加载模块，首次编译产生 ~14MB 缓存（`/tmp/jiti/`）。
2. **Node V8 编译缓存**：Node.js 解析 JS 模块时生成 ~19MB V8 字节码缓存（`/tmp/node-compile-cache/`，3000+ 文件）。

`/tmp/` 是临时文件系统，容器 destroy+create 后丢失。每次冷启动都要重新编译，在单核上耗时明显。

**解决方案**：在 bootstrap command 中将缓存持久化到 volume（`/app/data/cache/`）：
```bash
mkdir -p /app/data/cache/jiti /app/data/cache/node-compile-cache
ln -sfn /app/data/cache/jiti /tmp/jiti
export NODE_COMPILE_CACHE=/app/data/cache/node-compile-cache
```
同时在 machine env 中设置 `NODE_COMPILE_CACHE=/app/data/cache/node-compile-cache`。

### 插件预编译
`openclaw-plugins/telegram-router-proxy/` 同时保留 `index.ts`（源码）和 `index.js`（预编译）。`package.json` 的 `main` 和 `openclaw.extensions` 指向 `.js`，避免 OpenClaw 运行时编译 TS。修改插件后需同步更新 `.js` 文件。

### 容器就绪探测注意事项
bootstrap command 中的 IPv6 TCP proxy 在 OpenClaw 启动前就监听了 `[::]:8787` 和 `[::]:18789`。因此：
- **TCP 端口探测不可靠**：proxy 总是接受连接，但 OpenClaw 可能还没就绪，转发会 ECONNRESET。
- state sync 使用 **HTTP probe**（`POST /telegram-webhook`）代替 TCP probe，确保 OpenClaw 真正在处理请求。
- fly-probe 使用 **WebSocket 协议级探测**（gateway hello），不受 TCP proxy 影响。
- 只有 gateway（18789）和 webhook（8787）两个端口都就绪时才标记容器为 `running` 并通知用户。
