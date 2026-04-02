# PIN CLI 编码规范

面向 AI Agent 和开发者的编码约束文档。修改 `pin-cli/` 下任何代码前**必须先读完本文件**。

---

## 目标（每个 PR 只做一件事）

- 新增 domain 命令：添加 schema + repository + service + register，附带测试。
- 增强输出层：改进 envelope、format、error hint、dry-run。
- 修复 bug：定位 → 复现测试 → 修复 → 确认测试通过。
- 改进 UX：优化 help text、error message、flag 命名。

---

## 开发命令

在 `pin-cli/` 目录下执行：

```bash
npm install               # 安装依赖
npm run build             # TypeScript 编译 → dist/
npm run type-check        # tsc --noEmit（不产出文件，只检查类型）
npm run test              # 运行所有 *.test.ts
npm run dev -- sys doctor --json   # 免编译直接运行（tsx）
```

## 提交前检查清单

1. `npm run type-check` — 零错误
2. `npm run test` — 全部通过
3. `npm run build` — 编译成功
4. 不要提交 `dist/`、`node_modules/`、`.pin/` 目录
5. 不要提交任何 secrets、tokens、API keys

---

## 禁止事项

以下是 PIN CLI 的硬性约束，任何情况下都不得违反：

1. **不在 CLI 命令内嵌入任何 LLM / AI 调用。** CLI 是确定性工具层。所有 AI 行为留在调用方（agent）。
2. **不引入 `--user` 标志。** 单用户环境，命令不需要用户标识符。
3. **不依赖 `apis` 服务进行回写。** CLI 是本地优先的，与 OpenClaw 运行时解耦。
4. **不在 `--json` 输出中暴露原始 secrets。** 审计日志记录操作元数据，不记录 token 值。
5. **不使用非确定性行为。** 相同输入必须产生相同输出（除 timestamp/requestId 外）。
6. **不引入新依赖前未经评估。** 优先使用 Node.js 内置模块。新增 npm 依赖需在 PR 中说明理由。

---

## 目录约定

### 新增 Domain

每个 domain 必须包含以下文件，放在 `src/domains/<domain>/` 下：

```
src/domains/<domain>/
├── schema.ts          # Drizzle 表定义（sqliteTable）
├── repository.ts      # 数据访问层（CRUD，依赖 SqliteDatabase）
├── service.ts         # 命令执行逻辑（调用 repository，返回 RunCliResult）
├── register.ts        # Commander 命令注册（调用 service，写入 resultRef）
└── repository.test.ts # Repository 单元测试（可选但推荐）
```

新增 domain 后，还需要：
- 在 `src/db/schema.ts` 中重导出新 schema
- 在 `src/cli.ts` 的 `createProgram()` 中注册命令
- 在 `src/cli.test.ts` 中添加集成测试

### 文件职责边界

| 文件 | 允许 | 禁止 |
|------|------|------|
| `register.ts` | 定义 Commander 命令和 flags，调用 service | 直接操作数据库、包含业务逻辑 |
| `service.ts` | 调用 repository，构造 RunCliResult（含 envelope） | 直接操作 Commander，直接写 stdout |
| `repository.ts` | 操作数据库（Drizzle ORM 或 raw SQL） | 返回 envelope，了解 CLI 参数 |
| `schema.ts` | 定义 Drizzle 表结构 | 包含逻辑代码 |

---

## 输出层规范

### Envelope

所有命令输出**必须**通过 `okEnvelope()` 或 `errorEnvelope()` 构造：

```typescript
import { okEnvelope, errorEnvelope } from "../../output/envelope.js";

// 成功
return { exitCode: 0, stdout: okEnvelope("profile", "get", data) };

// 失败
return { exitCode: 1, stdout: errorEnvelope("profile", "get", "not_found", "NOT_FOUND", "Profile not found", "run `pin profile list` to see available profiles") };
```

禁止直接 `console.log()` 或构造裸 JSON 对象作为输出。

### Error 必须带 type 和 hint

每个 error 必须包含：
- `type`：错误分类（`validation` | `not_found` | `conflict` | `provider_unavailable` | `internal`）
- `code`：机器可读错误码（大写下划线，如 `NOT_FOUND`、`INVALID_ARGUMENT`）
- `message`：人类可读描述
- `hint`（强烈推荐）：Agent 可直接执行的修复命令或下一步操作

```typescript
// 好：hint 告诉 Agent 下一步做什么
errorEnvelope("ctx", "gmail search", "provider_unavailable", "PROVIDER_NOT_CONFIGURED",
  "Gmail provider not configured",
  "run `pin ctx apps setup gmail` to configure")

// 差：没有 hint，Agent 需要自己猜
errorEnvelope("ctx", "gmail search", "provider_unavailable", "PROVIDER_NOT_CONFIGURED",
  "Gmail provider not configured")
```

### 退出码

只使用三个退出码：

| 退出码 | 含义 | 对应 error.type |
|--------|------|----------------|
| `0` | 成功 | — |
| `1` | 业务错误 | `not_found`, `conflict`, `provider_unavailable`, `internal` |
| `2` | 参数校验失败 | `validation` |

细分错误类型通过 `error.type` 传递，不通过退出码区分。

### 写操作必须支持 --dry-run

所有 `INSERT` / `UPDATE` / `DELETE` 操作的命令必须检查 `--dry-run` flag。当 dry-run 生效时，返回将要执行的操作预览，不实际执行：

```typescript
if (options.dryRun) {
  return {
    exitCode: 0,
    stdout: okEnvelope("profile", "goals upsert", {
      dryRun: true,
      operation: "UPSERT",
      table: "goals",
      data: { key, title, priority },
    }),
  };
}
```

---

## 数据库规范

### Schema 定义

使用 Drizzle ORM 的 `sqliteTable` 定义表结构：

```typescript
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const goals = sqliteTable("goals", {
  key: text("key").primaryKey(),
  profileId: text("profile_id").notNull(),
  title: text("title").notNull(),
  priority: text("priority").notNull().$defaultFn(() => "medium"),
  status: text("status").notNull().$defaultFn(() => "active"),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .$defaultFn(() => ({})),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
```

### ensureSchema 模式

每个 repository 在首次操作前通过 `ensureSchema()` 创建表（`CREATE TABLE IF NOT EXISTS`）。这是当前的自举策略，不依赖外部迁移工具：

```typescript
private async ensureSchema(): Promise<void> {
  if (this.schemaReady) return;
  this.database.exec(`CREATE TABLE IF NOT EXISTS goals (...)`);
  this.schemaReady = true;
}
```

### 三库拆分规则

| 数据库 | 路径 | 存放内容 |
|--------|------|---------|
| `profile.db` | `${dataRoot}/data/profile.db` | profiles, goals, constraints, routines, memories |
| `events.db` | `${dataRoot}/data/events.db` | feedback_events, push_records, push_outcomes, agent_runs, agent_artifacts |
| `cache.db` | `${dataRoot}/data/cache.db` | apps_config, ctx_cache, rss_feeds, articles |

**注意**：当前 v1 使用单库 `pin.db`。迁移到三库拆分时需保持向后兼容，在 `PinDatabaseManager` 中处理。

### 通用字段约定

- 主键统一使用 `text` 类型（UUID 或业务 key）
- 时间字段统一使用 ISO 8601 字符串（`text` 类型）
- JSON 字段统一使用 `text("...", { mode: "json" })`
- 每张表必须有 `created_at`，可写表必须有 `updated_at`
- `metadata` 字段类型为 `Record<string, unknown>`，默认 `{}`

---

## 命令注册规范

### Commander 注册模式

```typescript
export const registerXxxCommands = (
  program: Command,
  runtime: CliRuntimeInput,
  resultRef: ResultRef,
): void => {
  const xxx = new Command("xxx");

  xxx.command("verb")
    .description("one-line description")
    .requiredOption("--id <id>", "resource identifier")
    .option("--format <fmt>", "output format: json | table | ndjson | pretty", "json")
    .option("--dry-run", "preview operation without executing")
    .option("--json", "shorthand for --format json")
    .action(async (options) => {
      resultRef.current = await doVerb(runtime, options);
    });

  program.addCommand(xxx);
};
```

### Flag 命名规则

- 使用 kebab-case：`--display-name`，不用 `--displayName`
- 布尔 flag 不带值：`--json`、`--dry-run`、`--yes`
- 资源标识符统一用 `--id`，业务 key 统一用 `--key`
- 时间参数使用 ISO 8601 格式，命名为 `--since`、`--until`、`--from`、`--to`
- 数量限制使用 `--limit`

### 子命令层级

domain 下允许最多两层子命令：

```bash
pin profile goals list          # domain → sub-resource → verb (OK)
pin profile goals upsert        # OK
pin ctx gmail search            # domain → provider → verb (OK)
pin ctx apps list               # OK
```

禁止三层以上嵌套。

---

## 安全规范

### 输入校验

处理来自用户输入或外部数据源（RSS、邮件）的字符串时，必须通过 sanitize 检查：

1. 拒绝危险 Unicode 字符（BiDi override U+202A-202E、zero-width U+200B-200D、U+FEFF）
2. 文件路径参数必须校验无路径遍历（`../`、绝对路径）
3. JSON 字符串参数必须在 service 层 parse 并验证类型

### 写操作确认

高风险写操作（批量删除、导入覆盖）需要 `--yes` flag 确认：

```typescript
if (risk === "high-risk-write" && !options.yes) {
  return {
    exitCode: 2,
    stdout: errorEnvelope("sys", "import", "validation", "CONFIRMATION_REQUIRED",
      "This operation will overwrite existing data",
      "add --yes to confirm"),
  };
}
```

---

## 测试规范

### 测试框架

使用 `node:test` + `node:assert/strict`，不引入第三方测试框架。

### 集成测试模式

通过 `runCli()` 函数测试完整命令流，使用临时目录隔离数据库：

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("profile create and get", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-test-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root }, homeDir: "/tmp" };
    const created = await runCli(["profile", "create", "--id", "test", "--display-name", "Alice", "--json"], runtime);
    assert.equal(created.exitCode, 0);
    assert.equal(created.stdout.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

### 测试覆盖要求

- 每个 domain 至少有一个集成测试覆盖主要 CRUD 路径
- 错误场景必须测试：NOT_FOUND、CONFLICT、INVALID_ARGUMENT
- envelope 结构必须断言：`exitCode`、`ok`、`error.code`、`meta.domain`、`meta.command`

---

## Skill 文档规范

Skill 文档面向 AI Agent，不是 API 参考文档。放在 `pin-cli/skills/<skill-name>/SKILL.md`。

### 格式要求

```markdown
---
name: pin-<domain>
version: 0.1.0
description: "一句话描述，用于 Agent 技能匹配。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "pin <domain> --help"
---

# <domain>

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 核心场景
描述 2-3 个主要业务场景，面向 Agent 如何使用这些命令解决实际问题。

## 命令列表
| 命令 | 说明 | 风险 |
|------|------|------|

## 安全规则
- ...
```

### Workflow Skill

编排多个 CLI 命令的工作流放在 `skills/pin-workflow-<name>/SKILL.md`，必须包含：
- 适用场景
- 前置条件
- 步骤流程图（ASCII）
- 每步的具体命令

---

## 代码风格

- TypeScript strict mode（`tsconfig.json` 已配置 `"strict": true`）
- 使用 ES module（`"type": "module"`），导入路径带 `.js` 后缀
- 不写不必要的注释，代码应自解释
- 函数优先使用 `const fn = async (...) => { ... }` 风格（与现有代码一致）
- 接口和类型定义使用 `interface`，不用 `type` 别名（简单联合类型除外）
- 错误处理：捕获后包装为 `errorEnvelope` 返回，不让异常逃逸到 `cli.ts`
