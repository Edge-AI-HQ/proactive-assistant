# OpenClaw 扩展策略：定制与上游兼容并行

> **基于 OpenClaw v2026.3.8**
> 本手册所有 API 参考、扩展点描述和代码示例均基于 `openclaw@2026.3.8` 版本验证。ContextEngine 自 v2026.3.7 起可用。升级到新版本后请对照 Changelog 核实是否有 breaking change。

> 日期：2026-03-12
> 作者：PIN AI Engineering
> 目标：在充分利用 OpenClaw 开源生态更新的同时，维护 PinAI 自有定制

---

## 一、核心原则

**不 Fork，只分层。** 所有定制通过 OpenClaw 的官方扩展点注入，核心代码保持原版。`npm install openclaw@latest` 就能升级，零 merge conflict。

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: Workspace                                         │  ← AGENTS.md / TOOLS.md / SOUL.md
│  (行为指令 / 人格 / 工具指南)                                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Extensions                                        │  ← 我们的定制
│  (plugins / skills / MCP servers / hooks / ContextEngine)    │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Configuration                                     │  ← openclaw.json
│  (models / channels / tools / sandbox / cron)                │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: OpenClaw Runtime                                  │  ← 原版，不修改
│  (gateway / agent loop / sandbox / plugin loader)            │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Infrastructure                                    │  ← Dockerfile + entrypoint
│  (image build / cache warmup / IPv6 bridge / volume)         │
└─────────────────────────────────────────────────────────────┘
```

**决策优先级：** 能用配置解决的不写代码 → 能用 Skill 解决的不写 Plugin → 能用 MCP 解决的不写 in-process → 能用官方 API 的不 monkey-patch。

---

## 二、OpenClaw 扩展点完整参考

OpenClaw 提供 **七大扩展机制**，按侵入性从低到高排列：

### 2.1 Workspace 文件（零代码，纯配置）

Workspace 是 AI agent 的"人格与行为指令层"。所有文件在每次 session 启动时加载。

| 文件 | 用途 | 加载时机 |
|------|------|---------|
| `AGENTS.md` | 操作指令、规则、优先级、行为约束 | 每次 session |
| `SOUL.md` | 人格定义（语气、风格、价值观） | 每次 session |
| `IDENTITY.md` | 身份声明（名字、角色） | 每次 session |
| `USER.md` | 用户画像（偏好、背景） | 每次 session |
| `TOOLS.md` | 工具使用指南与限制 | 每次 session |
| `BOOT.md` | Gateway 启动时执行的指令（需启用 `boot-md` hook） | Gateway 启动 |
| `HEARTBEAT.md` | 定期签到调度 | 按配置间隔 |

**PinAI 当前用法：** 通过 `platform-hooks` 插件的 `before_prompt_build` hook 动态注入 system guidance 和 onboarding profile，等效于运行时写入 AGENTS.md + USER.md。

**最佳实践：**
- 静态指令放 workspace 文件（构建时固化到镜像快照）
- 动态指令用 `before_prompt_build` hook 运行时注入
- 两者可叠加：workspace 文件提供基线，hook 追加用户特定内容

### 2.2 Skills（SKILL.md + 脚本）

Skills 是**给 AI 的操作手册**：Markdown 描述何时触发、怎么调用，附带可执行脚本。

#### 完整 SKILL.md 格式

```yaml
---
name: my-skill                          # 必填：小写 + 连字符
description: |                          # 必填：20-40 字，同时作为触发匹配
  When the user asks to do X, use this skill to accomplish Y.
version: 1.0.0                          # 可选：semver
user-invocable: true                    # 可选：是否暴露为 /slash 命令（默认 true）
disable-model-invocation: false         # 可选：是否从 AI prompt 中排除（默认 false）
command-dispatch: tool                  # 可选：跳过 LLM 直接路由到工具/脚本
metadata:
  openclaw:
    requires:
      env: [API_KEY]                    # 需要的环境变量
      bins: [python3]                   # 需要的可执行文件（全部）
      anyBins: [ffmpeg, avconv]         # 需要的可执行文件（任一）
      configs: [~/.config/app.json]     # 需要的配置文件
    primaryEnv: API_KEY                 # 主凭据环境变量
    emoji: "🔧"                        # 显示图标
    os: [linux, darwin]                 # 系统支持
---

## Instructions

Use `{baseDir}/scripts/run.sh` to execute...
```

#### Skill 加载优先级（高→低）

1. `<workspace>/skills/` — 当前 agent 专用
2. `~/.openclaw/skills/` — 本机全局（`openclaw skills install` 的目标）
3. 内置 skills — npm 包自带（`node_modules/openclaw/skills/`）
4. `skills.load.extraDirs` — openclaw.json 配置的额外目录

**关键行为：** OpenClaw 在 session 启动时快照 skill 列表，session 期间不会重新加载。

#### PinAI 当前用法与改进

**当前：** Dockerfile 中 `rm -rf` + `cp` 直接替换内置 skill 目录。

**改进方案（按推荐优先级）：**

1. **用 `skills.load.extraDirs`**（最优雅）：
   ```json
   // openclaw.json
   {
     "skills": {
       "load": { "extraDirs": ["/opt/pinai/skills"] }
     }
   }
   ```
   自定义 skill 放在 `/opt/pinai/skills/`，不触碰内置目录。同名 skill 的优先级取决于加载顺序——如需覆盖内置 skill，可在 `skills.entries` 中 disable 原版：
   ```json
   { "skills": { "entries": { "gws": { "enabled": false } } } }
   ```

2. **保持 COPY + replace**（当前方案，可接受）：如果必须完全替换内置 skill（如修改内置行为），在 CI 中加版本检查：
   ```bash
   # CI: 检查上游 skill 目录是否有我们未覆盖的新文件
   diff <(ls /usr/local/lib/node_modules/openclaw/skills/gws/) \
        <(ls pinai-openclaw/image/skills/gws/) || echo "WARNING: upstream skill changed"
   ```

#### 社区生态

- **ClawHub** 收录 5,700+ 社区 skill（CLI: `clawhub search`, `clawhub install`）
- 评估新功能前先搜索 ClawHub 和 awesome-openclaw-skills 仓库
- 注意：12-20% 社区 skill 存在安全问题，生产环境务必审计

### 2.3 MCP Server（Model Context Protocol）

MCP 是跨平台的标准化工具接口（不仅限于 OpenClaw，Cursor/Copilot/Windsurf 等也支持）。一个 MCP server 向 AI 暴露 tools、resources、prompts。

#### 配置方式

```json
// openclaw.json
{
  "agents": {
    "list": [{
      "id": "main",
      "mcp": {
        "servers": [
          {
            "name": "pinai-analytics",
            "command": "node",
            "args": ["/opt/pinai/mcp/analytics-server.js"],
            "env": { "DB_URL": "${ANALYTICS_DB_URL}" }
          },
          {
            "name": "notion",
            "command": "npx",
            "args": ["-y", "@notionhq/mcp"],
            "env": { "NOTION_API_KEY": "${NOTION_KEY}" }
          }
        ]
      }
    }]
  }
}
```

#### 传输方式

| 方式 | 适用场景 | 配置 |
|------|---------|------|
| **stdio**（默认） | 本地进程，低延迟 | `command` + `args` |
| **Streamable HTTP** | 远程 server | `url` + `headers` |

**注意：** SSE 传输模式下，不要用 URL query 参数传 API key（MCP SDK 的 SSE 在 POST 时会丢弃 query），用 `headers: { "x-api-key": "..." }` 代替。

#### 生命周期

1. **启动**：Gateway 启动时 spawn MCP server 子进程
2. **握手**：capability negotiation → 获取 tools/resources/prompts schema
3. **运行**：AI 按需调用 tool → Gateway 路由到对应 MCP server
4. **关闭**：Gateway shutdown 时广播 shutdown event

#### Skills vs MCP vs Plugin：何时用哪个

| 维度 | Skill | MCP Server | Plugin |
|------|-------|-----------|--------|
| **跨平台** | ✓（Claude Code/Cursor/Copilot 等） | ✓（MCP 标准） | ✗（OpenClaw 专用） |
| **隔离性** | 高（独立脚本进程） | 高（独立进程 + JSON-RPC） | 低（in-process） |
| **开发成本** | 低（Markdown + 脚本） | 中（需实现 MCP 协议） | 中-高（需理解 Plugin SDK） |
| **能力范围** | 指导 AI 使用已有工具 | 添加新工具/数据源 | 修改平台行为 |
| **适用场景** | 工作流编排、操作手册 | 外部 API/DB 集成 | HTTP 拦截、prompt 注入、自定义 channel |
| **性能** | 按需启动 | 常驻进程 | 零额外开销 |

**决策规则：**
- 如果只是"教 AI 怎么用一个命令" → **Skill**
- 如果需要"给 AI 一个新的数据源或 API" → **MCP Server**
- 如果需要"改变平台底层行为"（拦截请求、注入 prompt、自定义 channel） → **Plugin**

### 2.4 Plugin SDK（深度扩展）

Plugin 是运行在 Gateway 进程内的 TypeScript 模块，通过 `OpenClawPluginApi` 接口注册能力。

#### Plugin 结构

```
my-plugin/
├── openclaw.plugin.json    # 必须：manifest（id + configSchema）
├── package.json            # 必须：含 openclaw.extensions 字段
└── index.ts                # 入口：export default { id, register(api) }
```

**`package.json`：**
```json
{
  "name": "@pinai/my-plugin",
  "openclaw": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {}
}
```

**注意：** 依赖必须放 `dependencies`（不是 `devDependencies`），因为 OpenClaw 对插件目录执行 `npm install --omit=dev`。避免 `workspace:*` 语法。

#### OpenClawPluginApi 完整注册能力

```typescript
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

export default {
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'What it does',
  configSchema: { /* JSON Schema */ },

  register(api: OpenClawPluginApi) {

    // ── 工具注册 ──────────────────────────────────────
    api.registerTool({
      name: 'my_tool',
      description: 'Does something',
      parameters: { /* JSON Schema */ },
      handler: async (params, context) => { /* ... */ }
    });

    // ── 生命周期 Hook ─────────────────────────────────
    api.on('before_prompt_build', async (event) => {
      return {
        appendSystemContext: 'Extra system instructions...',
        prependSystemContext: 'Priority instructions...'
      };
    });

    api.on('before_model_resolve', async (event) => {
      return { modelOverride: 'claude-opus-4-6', providerOverride: 'litellm' };
    });

    api.on('before_tool_call', async (event) => {
      api.logger.info(`Tool call: ${event.toolName}`, { params: event.params });
    });

    api.on('after_tool_call', async (event) => {
      // 可修改 tool result
    });

    api.on('message_received', async (event) => { /* 入站消息 */ });
    api.on('message_sending', async (event) => { /* 出站前拦截 */ });
    api.on('message_sent', async (event) => { /* 出站后通知 */ });

    api.on('session_start', async (event) => { /* 会话初始化 */ });
    api.on('session_end', async (event) => { /* 会话清理 */ });
    api.on('agent_end', async (event) => { /* Agent 循环结束 */ });

    // ── HTTP 路由 ─────────────────────────────────────
    api.registerHttpRoute({
      path: '/my-webhook',
      match: 'POST',
      auth: 'plugin',  // 'gateway' | 'plugin'（plugin = 自管理认证）
      handler: async (req, res) => {
        res.json({ ok: true });
      }
    });

    // ── Gateway RPC 方法 ──────────────────────────────
    api.registerGatewayMethod('myPlugin.doSomething', async (params) => {
      return { result: 'done' };
    });

    // ── 后台服务 ──────────────────────────────────────
    api.registerService({
      id: 'my-background-worker',
      start: async () => { /* 启动 */ },
      stop: async () => { /* 清理 */ }
    });

    // ── Slash 命令 ────────────────────────────────────
    api.registerCommand({
      name: 'my-command',
      description: 'Does something without LLM',
      acceptsArgs: true,
      handler: async (args) => {
        return { text: `Result: ${args}` };
      }
    });

    // ── 自定义 LLM Provider ──────────────────────────
    api.registerProvider({
      id: 'my-provider',
      name: 'My LLM Provider',
      // ... provider interface
    });

    // ── 自定义 Channel ───────────────────────────────
    api.registerChannel({
      plugin: {
        id: 'my-channel',
        meta: { name: 'My Channel', icon: '📡' },
        capabilities: { /* chat types, features */ },
        sendText: async ({ cfg, to, text, accountId }) => {
          return { ok: true, messageId: '...', timestamp: Date.now() };
        },
        sendMedia: async (params) => { /* ... */ },
        listAccountIds: () => ['default'],
        resolveAccount: (id) => ({ /* ... */ }),
        isConfigured: () => true,
      }
    });

    // ── ContextEngine ────────────────────────────────
    api.registerContextEngine('my-engine', (runtime) => ({
      bootstrap: async () => { /* 初始化 */ },
      ingest: async (messages) => { /* 接收消息 */ },
      assemble: async () => { /* 组装 context */ },
      compact: async () => { /* 压缩 */ },
      afterTurn: async () => { /* 每轮清理 */ },
      prepareSubagentSpawn: async () => { /* 子 agent 上下文 */ },
      onSubagentEnded: async () => { /* 子 agent 结束 */ },
    }));

    // ── 日志 ──────────────────────────────────────────
    api.logger.info('Plugin initialized');
    api.logger.warn('Something unexpected', { detail: '...' });
    api.logger.error('Failed', { error: err });
  }
};
```

#### Plugin 配置管理

**`openclaw.plugin.json` 的 `configSchema`：**
```json
{
  "id": "telegram-api-proxy",
  "configSchema": {
    "type": "object",
    "properties": {
      "routerUrl": {
        "type": "string",
        "description": "PinAI Telegram router URL",
        "default": "http://host.docker.internal:3000"
      },
      "blockedMethods": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["setWebhook", "deleteWebhook", "getUpdates"]
      }
    }
  }
}
```

**通过 `openclaw.json` 传入配置：**
```json
{
  "plugins": {
    "entries": {
      "telegram-api-proxy": {
        "enabled": true,
        "config": {
          "routerUrl": "${TELEGRAM_ROUTER_URL}",
          "blockedMethods": ["setWebhook", "deleteWebhook"]
        }
      }
    }
  }
}
```

支持 `${ENV_VAR}` 语法引用环境变量。

#### Plugin 发现与加载

Plugin loader 按以下顺序发现插件：
1. `extensions/` workspace 目录（含 `openclaw.extensions` 字段的 `package.json`）
2. `node_modules/@openclaw/*` 和 `node_modules/@*/openclaw-*`
3. `plugins.load.paths` 配置（`openclaw.json`）
4. `OPENCLAW_PLUGIN_LOAD_PATHS` 环境变量（我们当前使用的方式）

**启用控制：**
```json
{
  "plugins": {
    "allow": ["plugin-a", "plugin-b"],    // 白名单
    "deny": ["plugin-c"],                  // 黑名单（优先级 > allow）
    "entries": {
      "plugin-a": { "enabled": true }     // 个别开关
    }
  }
}
```

#### Plugin Slot 系统

OpenClaw 定义了四种 slot type，同类型插件只能选一个生效：

| Slot | 选择方式 | 用途 |
|------|---------|------|
| `memory` | `plugins.slots.memory` | 内存/持久化后端 |
| `contextEngine` | `plugins.slots.contextEngine` | 上下文管理策略 |
| Channel | 自动注册 | 消息平台适配 |
| Provider | 自动注册 | LLM 提供商 |

### 2.5 Hooks（事件驱动自动化）

独立于 Plugin 的轻量级事件处理机制。Hook 是一个目录，包含 `HOOK.md`（元数据）+ `handler.ts`（逻辑）。

#### Hook 发现位置

1. `<workspace>/hooks/` — agent 专用
2. `~/.openclaw/hooks/` — 全局
3. 内置 hook packs

#### 完整事件列表

**Gateway 生命周期：**
| 事件 | 触发时机 | 典型用途 |
|------|---------|---------|
| `gateway_start` | Gateway 进程启动 | 初始化外部连接 |
| `gateway_stop` | Gateway 进程关闭 | 清理资源 |

**Session 生命周期：**
| 事件 | 触发时机 | 典型用途 |
|------|---------|---------|
| `session_start` | 新 session 创建 | 加载用户上下文 |
| `session_end` | Session 结束 | 保存状态、清理 |
| `command:new` | `/new` 命令执行 | 重置状态 |
| `command:reset` | `/reset` 命令执行 | 重置 session |
| `command:stop` | `/stop` 命令执行 | 停止 agent |

**Agent 执行循环（按执行顺序）：**
| 事件 | 触发时机 | 可返回值 |
|------|---------|---------|
| `before_model_resolve` | Session 加载前 | `{ modelOverride, providerOverride }` |
| `agent:bootstrap` | System prompt 最终化前 | 注入额外上下文 |
| `before_prompt_build` | Session 加载后 | `{ appendSystemContext, prependSystemContext }` |
| `before_tool_call` | 工具执行前 | 拦截/修改参数 |
| `after_tool_call` | 工具执行后 | 修改返回值 |
| `tool_result_persist` | 结果持久化前 | 同步修改（必须同步！） |
| `before_compaction` | Context 压缩前 | 标记保护内容 |
| `after_compaction` | Context 压缩后 | 注入补充内容 |
| `agent_end` | Agent 循环结束 | 审计、统计 |

**消息流：**
| 事件 | 触发时机 | 典型用途 |
|------|---------|---------|
| `message_received` | 入站消息 | 预处理、过滤 |
| `message_sending` | 出站前 | 审查、改写 |
| `message_sent` | 出站后 | 日志、通知 |

#### 内置 Hook Packs

| Hook Pack | 功能 |
|-----------|------|
| `session-memory` | `/new` 时保存 session 上下文 |
| `bootstrap-extra-files` | `agent:bootstrap` 时注入额外 workspace 文件 |
| `command-logger` | 记录所有命令事件 |
| `boot-md` | Gateway 启动时执行 `BOOT.md` |

管理命令：`openclaw hooks enable <name>` / `openclaw hooks disable <name>`

### 2.6 ContextEngine Plugin（v2026.3.7+）

控制 AI 如何管理、压缩和组装上下文的插件化框架。

#### 7 个生命周期 Hook

```
session start
    │
    ▼
bootstrap ──→ 初始化引擎状态
    │
    ▼
ingest ←──── 每条新消息
    │
    ▼
assemble ───→ 构建发给 LLM 的 context window
    │
    ▼
[LLM response]
    │
    ▼
afterTurn ──→ 每轮后清理/统计
    │
    ├──→ compact ──→ 当 context 超过阈值时压缩
    │
    ├──→ prepareSubagentSpawn ──→ 为子 agent 准备隔离 context
    │
    └──→ onSubagentEnded ──→ 合并子 agent 结果
```

#### 注册方式

```typescript
api.registerContextEngine('pinai-context', (runtime) => ({
  async bootstrap() {
    // 从 SQLite / Redis 恢复历史
  },
  async ingest(messages) {
    // 存储到持久化层
  },
  async assemble() {
    // 组装 context：system prompt + 压缩历史 + 最近 N 条消息
    return {
      messages: [...systemMessages, ...compressedHistory, ...recentMessages],
      metadata: { tokenCount: 12000 }
    };
  },
  async compact() {
    // 自定义压缩策略：摘要 / 向量检索 / DAG 等
  },
  async afterTurn() {
    // 更新统计、清理临时数据
  }
}));
```

#### Slot 选择

```json
// openclaw.json
{
  "plugins": {
    "slots": {
      "contextEngine": "pinai-context"
    }
  }
}
```

未配置时自动使用 `LegacyContextEngine`（零行为变更）。

#### 社区参考：lossless-claw

[lossless-claw](https://github.com/Martian-Engineering/lossless-claw) 实现了无损上下文管理：
- SQLite 持久化全部对话历史
- LLM 生成分层摘要（DAG 结构）
- `freshTailCount=32`：保留最近 32 条原始消息
- `contextThreshold=0.75`：context 占用 75% 时触发压缩
- 提供 `lcm_grep`（搜索历史）、`lcm_expand`（展开摘要）等工具

### 2.7 Webhook（外部系统触发）

允许外部系统通过 HTTP POST 触发 OpenClaw 动作。

```json
// openclaw.json
{
  "webhooks": {
    "enabled": true,
    "token": "${WEBHOOK_AUTH_TOKEN}",
    "mappings": {
      "deploy-notify": {
        "path": "/webhook/deploy",
        "action": "send_message",
        "channel": "telegram",
        "accountId": "private"
      }
    }
  }
}
```

---

## 三、Tool 权限系统

扩展添加的工具受 OpenClaw 的权限系统控制。理解此系统对安全扩展至关重要。

### 权限评估顺序

```
Base Profile → Provider Profile → Allow/Deny
```

### 内置 Profile

| Profile | 包含的工具 |
|---------|----------|
| `full` | 无限制 |
| `minimal` | 仅 `session_status` |
| `coding` | `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image` |
| `messaging` | `group:messaging`, `sessions_*`, `session_status` |

### Tool Group

| Group | 包含 |
|-------|------|
| `group:runtime` | exec, bash, process |
| `group:fs` | read, write, edit, apply_patch |
| `group:sessions` | sessions_list/history/send/spawn, session_status |
| `group:memory` | memory_search, memory_get |
| `group:web` | web_search, web_fetch |
| `group:ui` | browser, canvas |
| `group:automation` | cron, gateway |
| `group:messaging` | message |

### 配置示例

```json
{
  "tools": {
    "profile": "full",
    "allow": ["exec", "read", "write", "my_tool"],
    "deny": ["browser"],
    "byProvider": {
      "openai/gpt-4o": {
        "allow": ["read", "write"],
        "deny": ["exec"]
      }
    }
  }
}
```

**Plugin 注册的工具** 自动进入工具池，受 `tools.allow/deny` 管控。MCP server 暴露的工具同理。

---

## 四、当前定制清单与扩展点映射

| 我们的定制 | 当前实现方式 | 使用的扩展点 | 评估 | 改进建议 |
|-----------|-------------|-------------|------|---------|
| Telegram API 代理 | `globalThis.fetch` patch | Plugin SDK | ✓ 正确 | 可用 `configSchema` 管理 routerUrl |
| LiteLLM Vision 适配 | `globalThis.fetch` patch | Plugin SDK | ✓ 正确 | 同上 |
| System guidance 注入 | `before_prompt_build` hook | Plugin Hook | ✓ 最佳实践 | — |
| Onboarding profile | `before_prompt_build` hook | Plugin Hook | ✓ 最佳实践 | — |
| Cron delivery 补全 | `before_tool_call` hook 拦截 cron add | Plugin Hook | ✓ 已迁移 | ~~fetch patch~~ → hook，精准拦截 |
| 设备自动配对 | 预写 `paired.json` + `registerService` 轮询 | Plugin SDK | ✓ 已迁移 | ~~setInterval~~ → registerService 生命周期管理 |
| 自定义 Skills | `skills.load.extraDirs` + 仅删 2 个重叠 bundled | 配置层 | ✓ 已迁移 | ~~Dockerfile rm+cp~~ → extraDirs |
| Exec approvals | 写入配置文件 | 配置层 | ✓ | — |
| Slash commands | 未使用 | — | — | 可用 `registerCommand` 添加 |
| 自定义 channel | 未需要 | — | — | 如需接入新 IM，用 `registerChannel` |
| 自定义 LLM provider | 未需要（走 LiteLLM） | — | — | 如 LiteLLM 不够，用 `registerProvider` |
| Analytics/审计 | 未实现 | — | — | 用 `after_tool_call` + `agent_end` hook |
| Cache warmup | Dockerfile RUN | 基础设施层 | ✓ 有效优化 | — |
| IPv6 bridge | entrypoint 脚本 | 基础设施层 | ✓ | — |

---

## 五、扩展模式手册（Patterns & Recipes）

### Pattern 1: HTTP 流量拦截（fetch patch）

**适用于：** 改写出站 HTTP 请求的目标/header/body。

```typescript
// 标准 fetch patch 模式（带去重保护）
const PATCH_KEY = '__myPlugin_patched__';
if ((globalThis.fetch as any)[PATCH_KEY]) return;

const originalFetch = globalThis.fetch;
const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (shouldIntercept(url)) {
    return handleIntercepted(url, init);
  }
  return originalFetch(input, init);
};
(patchedFetch as any)[PATCH_KEY] = true;
globalThis.fetch = patchedFetch;
```

**PinAI 两个插件使用此模式**（Telegram API 代理、LiteLLM Vision 适配）。Cron delivery 已迁移到 `before_tool_call` hook。合理场景包括 API 代理、流式适配、请求审计。

**注意事项：**
- 必须加去重 guard（`__patchedKey__`），避免热重载时多层包装
- 异常时必须 fallback 到 `originalFetch`，否则所有 HTTP 请求失败
- 上游升级后测试所有 fetch 路径

### Pattern 2: System Prompt 注入

**适用于：** 运行时向 AI 注入动态指令。

```typescript
api.on('before_prompt_build', async (event) => {
  const guidance = await loadGuidance();      // 静态文件
  const profile = await loadUserProfile();     // 动态：per-user

  return {
    prependSystemContext: profile,             // 高优先级：放在最前
    appendSystemContext: guidance              // 低优先级：放在最后
  };
});
```

**与 workspace 文件的分工：**
- Workspace 文件（AGENTS.md 等）：静态、构建时确定、所有用户共享
- `before_prompt_build` hook：动态、运行时计算、per-session 差异化

### Pattern 3: 工具执行审计

**适用于：** 记录/拦截 AI 对工具的调用。

```typescript
api.on('before_tool_call', async (event) => {
  api.logger.info(`Tool invoked: ${event.toolName}`, {
    runId: event.runId,
    params: sanitize(event.params)  // 去掉敏感字段
  });

  // 可选：阻止执行
  if (isDangerous(event.toolName, event.params)) {
    return { blocked: true, reason: 'Policy violation' };
  }
});

api.on('after_tool_call', async (event) => {
  await sendToAnalytics({
    tool: event.toolName,
    duration: event.duration,
    success: !event.error
  });
});
```

### Pattern 4: 后台服务（替代 setInterval）

**适用于：** 需要持续运行的后台任务（如健康检查、轮询外部系统）。

```typescript
api.registerService({
  id: 'device-pairing-watcher',
  async start() {
    this.timer = setInterval(async () => {
      const pending = await getPendingPairRequests();
      for (const req of pending) {
        await approvePairRequest(req.id);
      }
    }, 3000);
  },
  async stop() {
    clearInterval(this.timer);
  }
});
```

**优势：** Gateway 关闭时自动调用 `stop()`，资源清理有保证。

### Pattern 5: 自定义 Gateway RPC

**适用于：** 从 APIs 侧调用 OpenClaw 容器内的自定义逻辑。

```typescript
// 插件侧：注册 RPC 方法
api.registerGatewayMethod('pinai.getStatus', async (params) => {
  return {
    uptime: process.uptime(),
    sessions: getActiveSessions(),
    memory: process.memoryUsage()
  };
});

// APIs 侧：调用
const result = await gatewayRpc(machineUrl, 'pinai.getStatus', {});
```

### Pattern 6: 自定义 Slash 命令

**适用于：** 不经过 LLM、直接执行的用户操作。

```typescript
api.registerCommand({
  name: 'status',
  description: 'Show PinAI container status',
  handler: async () => {
    const uptime = Math.floor(process.uptime());
    const mem = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
    return { text: `Uptime: ${uptime}s | Memory: ${mem}MB` };
  }
});
```

用户输入 `/status` 即可触发，不消耗 LLM token。

### Pattern 7: 自定义 HTTP 端点

**适用于：** 接收外部 webhook、暴露 health check。

```typescript
api.registerHttpRoute({
  path: '/health',
  match: 'GET',
  auth: 'plugin',  // 自管理认证，跳过 gateway token
  handler: async (req, res) => {
    const healthy = checkHealth();
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded' });
  }
});
```

**可替代当前的 `workspace-status-server.js`**——用 Plugin HTTP route 代替独立 Node 脚本。

### Pattern 8: Model/Provider 动态切换

**适用于：** 按条件选择不同的 LLM model/provider。

```typescript
api.on('before_model_resolve', async (event) => {
  // 根据消息内容选择模型
  if (event.hasImages) {
    return { modelOverride: 'claude-opus-4-6' };  // 视觉能力
  }
  if (event.isSimpleQuery) {
    return { modelOverride: 'claude-haiku-4-5' };  // 省成本
  }
  // 不返回 = 使用默认
});
```

### Pattern 9: MCP Server 开发（Node.js）

**适用于：** 添加新的工具/数据源，需要进程隔离。

```typescript
// /opt/pinai/mcp/analytics-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({ name: 'pinai-analytics', version: '1.0.0' }, {
  capabilities: { tools: {} }
});

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'query_analytics',
    description: 'Query PinAI analytics data',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SQL query' },
        timeRange: { type: 'string', enum: ['1h', '24h', '7d', '30d'] }
      },
      required: ['query']
    }
  }]
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'query_analytics') {
    const result = await executeQuery(request.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 六、安全考量

### Plugin 信任模型

**Plugin 运行在 Gateway 进程内，拥有完全权限。** 这意味着：
- Plugin 可以访问所有环境变量（包括 secrets）
- Plugin 可以 patch `globalThis.fetch`、读写文件系统
- 恶意 Plugin = 完全控制容器

**缓解措施：**
1. 只加载自研 Plugin，不从不信任来源安装
2. Plugin 代码走 code review + CI
3. `gateway.bind: "loopback"` 限制网络访问
4. 不在 Plugin 中硬编码 secrets，用 `${ENV_VAR}` 或 `configSchema`

### MCP Server 信任模型

MCP server 是独立进程，隔离度更高：
- 只能访问配置中传入的 `env`
- 通过 JSON-RPC 通信，不能直接访问 Gateway 内存
- 可以配置 sandbox（`sandbox.docker.network: 'none'`）

### 社区扩展审计

- ClawHub 12-20% 社区 skill 有安全风险
- 安装前检查：源码审计、star 数、维护活跃度
- 生产环境：明确 `plugins.allow` 白名单，禁止自动发现未知插件

---

## 七、扩展点选择决策树

```
需要添加新功能？
│
├─ 只是改变 AI 的行为/人格/指令？
│  └─ 修改 Workspace 文件（AGENTS.md / SOUL.md / TOOLS.md）
│
├─ 教 AI 使用一个命令/工作流？
│  └─ 写 Skill（SKILL.md + 脚本）
│     ├─ 需要跨平台兼容 → Skill（Claude Code/Cursor 也能用）
│     └─ 仅 OpenClaw → Skill 或 registerCommand
│
├─ 给 AI 添加新工具/数据源？
│  ├─ 社区已有 MCP server → 配置 mcpServers
│  ├─ 需自建 + 需进程隔离 → 写 MCP server
│  └─ 需自建 + 需 Gateway 内访问 → registerTool
│
├─ 拦截/改写 HTTP 流量？
│  └─ Plugin fetch patch
│
├─ 注入/修改 AI system prompt？
│  ├─ 静态内容 → Workspace 文件
│  └─ 动态内容 → Plugin before_prompt_build hook
│
├─ 响应系统事件？
│  ├─ 轻量、独立 → Hook（HOOK.md + handler.ts）
│  └─ 需要 API 注册 → Plugin api.on(event)
│
├─ 暴露 HTTP 端点？
│  └─ Plugin registerHttpRoute
│
├─ 添加 Slash 命令？
│  └─ Plugin registerCommand
│
├─ 自定义上下文管理？
│  └─ ContextEngine plugin（v2026.3.7+）
│
├─ 接入新消息平台？
│  └─ Plugin registerChannel
│
├─ 接入新 LLM 提供商？
│  └─ Plugin registerProvider
│
├─ 需要后台常驻任务？
│  └─ Plugin registerService
│
├─ 需要 Gateway RPC 扩展？
│  └─ Plugin registerGatewayMethod
│
├─ 需要修改 OpenClaw 核心？
│  └─ 提 PR 到上游，不 Fork
│
└─ 基础设施/运维变更？
   └─ Dockerfile / entrypoint（Layer 1）
```

---

## 八、升级策略

### 8.1 版本锁定 + 渐进升级

```dockerfile
# Dockerfile 中严格锁定版本
RUN npm install -g openclaw@2026.3.8
```

### 8.2 升级流程

```
1. 读 Changelog
   └─ 重点：Plugin SDK、Hook API、openclaw.json schema 变更
   └─ 用 `openclaw doctor` 自动检测 config schema 迁移

2. 本地验证
   └─ npm install -g openclaw@<new>
   └─ 运行 warmup（验证插件加载 + jiti 编译）
   └─ 运行集成测试（覆盖所有 fetch patch 路径）

3. Dev 环境部署
   └─ 构建新镜像 → 推送 → 更新 OPENCLAW_IMAGE digest
   └─ 创建测试容器 → 验证四条通信链路

4. Prod 发布
   └─ 通过 CI/CD（禁止手动 flyctl）
   └─ 验收：日志检查 + P0 密钥抽检
```

### 8.3 兼容性验证矩阵

| 检查项 | 方法 | 失败影响 |
|--------|------|---------|
| Plugin 加载 | warmup 日志无 `ERROR` / `WARN` | 插件不生效 |
| Skill 目录结构 | `diff` 新旧版本 `skills/` | 自定义 skill 覆盖不完整 |
| Hook 签名 | 对比 SDK `.d.ts` 类型定义 | Hook 返回值被忽略 |
| `device-pair` API | 检查 SDK export path 是否存在 | 自动配对失败 |
| `openclaw.json` schema | `openclaw doctor` | 配置字段废弃/改名 |
| Gateway 端口/协议 | Changelog + 集成测试 | 通信链路断裂 |
| jiti 缓存兼容 | warmup 阶段是否报 cache miss | 冷启动变慢（不致命） |

### 8.4 社区同步

- **GitHub Releases**：订阅 watch，每个 minor 版本评估
- **GitHub Discussions**：Plugin SDK 变更预告、Breaking change RFC
- **ClawHub**：定期搜索可替代自建实现的社区方案
- **lossless-claw**：跟踪 ContextEngine API 稳定性

---

## 九、近期可执行改进

### P1: configSchema 声明式配置

**工作量：** 小（每个插件 30 分钟）
**风险：** 低
**收益：** 配置可审计、可通过 CLI 管理

将三个插件的 `process.env.XXX` 读取迁移到 `configSchema`，通过 `openclaw.json` 的 `plugins.entries` 传入。

### ~~P1: Skills 改用 `extraDirs`~~ ✅ 已完成（2026-03-13）

自定义 skills 已迁移到 `/opt/pinai/skills/`，通过 `skills.load.extraDirs` 加载。仅对 2 个同名 bundled skill（`openai-image-gen`、`openai-whisper-api`）执行 `rm -rf`，因 extraDirs 优先级最低。运行时配置构建器自动注入 `extraDirs`。

### ~~P2: 设备配对改用 registerService~~ ✅ 已完成（2026-03-13）

轮询逻辑已包装在 `api.registerService({ id: "device-auto-pairing" })`，Gateway 关闭时自动调用 `stop()` 清理定时器。`prePairDeviceIdentity()` 仍在 register 阶段同步运行（需在 gateway ready 前完成）。

### ~~P1.5: Cron delivery 改用 `before_tool_call` hook~~ ✅ 已完成（2026-03-13）

已从 `globalThis.fetch` patch 迁移到 `api.on("before_tool_call")` hook。仅在 `toolName === "cron"` 且 `action === "add"` 时触发，通过 hook context 的 `sessionKey` 推断 delivery target。

### P2: workspace-status-server 改用 registerHttpRoute

**工作量：** 中
**风险：** 低
**收益：** 减少一个独立 Node 进程，简化 entrypoint

### P3: 新集成走 MCP Server

**工作量：** 视集成复杂度
**风险：** 低（进程隔离）
**收益：** 标准协议、社区复用、崩溃不影响 Gateway

### P3: 添加 analytics hooks

**工作量：** 中
**风险：** 低
**收益：** Tool 使用审计、token 消耗统计、异常检测

### P4: ContextEngine 实验

**工作量：** 大
**风险：** 高（API 不稳定）
**收益：** 自定义上下文压缩、长对话记忆

---

## 十、风险矩阵

| 风险 | 可能性 | 影响 | 缓解 |
|------|--------|------|------|
| Plugin SDK breaking change | 中 | 高：插件不可用 | 版本锁定 + CI warmup 门禁 + changelog 审查 |
| fetch patch 与上游冲突 | 低 | 中：请求路由异常 | 去重 guard + 集成测试覆盖所有路径（已减少到 2 个 fetch patch） |
| 社区 MCP/Skill 安全风险 | 中 | 高：容器被控 | 白名单 + 审计 + sandbox |
| Skill 替换在新版本失效 | 低 | 低：仅 2 个重叠 skill | 已改用 extraDirs，仅 `openai-image-gen`/`openai-whisper-api` 需 rm |
| ContextEngine API 变化 | 高 | 中：context 策略失效 | 暂不在 prod 用，等 API 稳定 |
| jiti 缓存与新版本不兼容 | 低 | 低：冷启动变慢 | warmup 阶段自动重建缓存 |
| Plugin 内存泄漏影响 Gateway | 低 | 高：容器 OOM | registerService 管理生命周期 + 监控内存 |

---

## 十一、总结

OpenClaw 提供了从零代码到深度定制的完整扩展光谱：

```
零代码 ──────────────────────────────────────────────► 深度定制
Workspace    Skill     MCP Server    Hook    Plugin    ContextEngine
文件          Markdown   独立进程      事件     in-process  上下文接管
```

**核心策略：选择最左侧能满足需求的扩展点。** 越往左侵入性越低、升级越安全、开发越简单。

当前 PinAI 的三个 Plugin + 六个 Skill + `extraDirs` 配置的架构方向是正确的。2026-03-13 已完成三项迁移（cron → hook、pairing → registerService、skills → extraDirs），剩余改进方向：

1. **用好 Plugin SDK 的声明式能力**（configSchema、registerHttpRoute）替代手工操作
2. **新集成优先走 MCP**（进程隔离 + 社区生态）
3. **持续跟踪 ContextEngine 成熟度**

**一句话：不改 OpenClaw 一行核心代码，通过七层扩展点覆盖所有定制需求，`npm update` 即可拥抱上游更新。**
