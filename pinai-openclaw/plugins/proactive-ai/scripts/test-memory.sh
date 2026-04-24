#!/usr/bin/env bash
# 一键回归 memory 模块（含 evolution / dreaming / crystallize / raw）
#
# 用法：
#   bash pinai-openclaw/plugins/proactive-ai/scripts/test-memory.sh
#
# 三层覆盖（顺序很重要，先 schema 再迁移再端到端）：
#   1. schema + helper 单测      —— 表结构和读写助手
#   2. 迁移回放                  —— v2 旧表 + 旧数据 → v3 sink
#   3. 端到端 + CLI 烟雾         —— 全链路 + 所有 pin 子命令
#
# 任意一步红就立刻退出，方便定位最早断在哪一层。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PLUGIN_DIR"

run() {
  local label="$1"; shift
  echo
  echo "──────────────────────────────────────────────────────────────────────"
  echo "▶ $label"
  echo "──────────────────────────────────────────────────────────────────────"
  npx tsx --test "$@"
}

# ─── 1. schema + helper 单测 ──────────────────────────────────────────────
run "[1/3] schema + helper" \
  db.memory.test.ts \
  db.personal-signals.test.ts \
  db.world-signals.test.ts \
  db.evolution-runs.test.ts \
  db.skill-index.test.ts \
  db.app-state.test.ts \
  db.intent-state.test.ts \
  db.card-evaluations.test.ts \
  db.pipeline-artifact.test.ts \
  raw-db.test.ts \
  shared/composio-key.test.ts

# ─── 2. 迁移回放：v2 → v3 兼容硬保证 ──────────────────────────────────────
# 每个文件先 CREATE 出 v2 旧表 + 灌入旧数据，再让 openProactiveDb() 跑迁移，
# 断言数据完整迁到 v3 sink、旧表 DROP 干净。
run "[2/3] migrations (v2 → v3 兼容)" \
  db.legacy-migration.test.ts \
  db.phase15-migration.test.ts \
  db.phase2b-migration.test.ts \
  db.phase2c-migration.test.ts \
  db.phase2d-migration.test.ts \
  db.phase2e-goals-references.test.ts

# ─── 3. 端到端 + CLI 烟雾 ─────────────────────────────────────────────────
# v3-end-to-end: device ingest → personal_signals → evolution → memory + ref bump
# evolution-three-triggers: chat_burst / daily_dream / manual 三条触发路径
# cli/v3-cli + cli/v3-review-fixes: 所有 pin 子命令的形状 + 输入校验烟雾
# cli/cards: cards 子命令（feedback / select / list）
# routes/*.test.ts: 路由层契约（dreaming HTTP / mobile ingest / 等）
run "[3/3] end-to-end + CLI + routes smoke" \
  v3-end-to-end.test.ts \
  evolution-three-triggers.test.ts \
  cli/v3-cli.test.ts \
  cli/v3-review-fixes.test.ts \
  cli/cards.test.ts \
  routes/v3-routes.test.ts \
  routes/dreaming.test.ts \
  routes/crystallize.test.ts \
  routes/mobile.test.ts \
  pipeline/agent-runner.test.ts

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "✅ memory 模块全部测试通过。"
echo "   schema/helper / 迁移回放 / 端到端+CLI 三层都没断。"
echo "──────────────────────────────────────────────────────────────────────"
