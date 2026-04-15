# API DB Migrations

`001_baseline.sql` 是完整的初始 schema。后续每次 schema 变更新增一个编号递增的文件（如 `002_xxx.sql`）。

## 执行方式

**自动（推荐）**：dev/prod 部署时 `fly.toml` 的 `release_command` 会自动调用 `scripts/run-all-migrations.mjs`，按编号顺序执行所有未跑过的 migration。已执行的记录在 `schema_migrations` 表中。

**手动（单个 migration）**：`npm run db:migrate -- <NNN>`，例如 `npm run db:migrate -- 002`。

**新建库**：直接部署即可，`run-all-migrations.mjs` 会从 001 开始全部执行。
