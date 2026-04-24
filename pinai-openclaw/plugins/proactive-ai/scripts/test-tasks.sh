#!/usr/bin/env bash
# 一键回归 background_tasks 模块（Phase A 基建 + Phase B connector.init + Phase B.1 evolve）
#
# 用法：
#   bash pinai-openclaw/plugins/proactive-ai/scripts/test-tasks.sh
#
# 七层覆盖（顺序很重要，从最底层往上跑，红了立刻退出）：
#   1. db.background-tasks.test.ts            —— enqueue / claim / heartbeat /
#                                                recover / cancel 全路径 + lease 严格校验
#   2. tasks/scheduler.test.ts                —— BackgroundTaskScheduler tick / reaper /
#                                                handler crash retry / 重入串行化
#   3. cli/tasks.test.ts                      —— pin tasks list/show/attempts/cancel/enqueue
#                                                envelope 形状 + 输入校验
#   4. tasks/handlers/connector-init.test.ts  —— Gmail + GCal 全链路 (mock Composio):
#                                                fetch → raw → signals → evolution_run
#                                                + refs_consumed; 含 Phase B.1 evolve 集成
#   5. tasks/handlers/connector-evolve.test.ts —— Phase B.1 evolve 单元: prompt 采样 /
#                                                LLM 失败兜底 / 输出 sanitization /
#                                                memory_write + delta + refs_produced
#   6. tasks/reconciler.test.ts               —— ACTIVE 扫描 + 幂等 + 失败兜底
#   7. routes/composio.test.ts                —— /composio/wait → enqueue 钩子
#
# 这套脚本和 test-memory.sh 的关系：
# - test-memory.sh 守 v3 memory/personal_signals/evolution_runs 的契约。
# - test-tasks.sh  守 background_tasks 队列 + scheduler + connector.init/evolve + CLI。
# - 两套各自独立可跑；CI 里都过才算验收通过。

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

# ─── Phase A：基建 ─────────────────────────────────────────────────────────
run "[1/7] schema + repository" \
  db.background-tasks.test.ts
run "[2/7] scheduler tick + handler" \
  tasks/scheduler.test.ts
run "[3/7] pin tasks CLI" \
  cli/tasks.test.ts

# ─── Phase B + B.1：connector.init + evolve + 接线 ─────────────────────────
run "[4/7] connector.init handler (Gmail + GCal, mock Composio)" \
  tasks/handlers/connector-init.test.ts
run "[5/7] connector-evolve (LLM-injected fact extraction)" \
  tasks/handlers/connector-evolve.test.ts
run "[6/7] reconciler" \
  tasks/reconciler.test.ts
run "[7/7] /composio/wait → enqueue hook" \
  routes/composio.test.ts

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "✅ background_tasks (Phase A + B + B.1) 全部测试通过。"
echo "   schema/repo / scheduler / CLI / connector.init / connector-evolve / reconciler / wait-hook 七层都没断。"
echo "──────────────────────────────────────────────────────────────────────"
