#!/usr/bin/env bash
# 一键回归 background_tasks 模块（Phase A 基建 + B connector.init + B.1 evolve + C dreaming）
#
# 用法：
#   bash pinai-openclaw/plugins/proactive-ai/scripts/test-tasks.sh
#
# 九层覆盖（顺序很重要，从最底层往上跑，红了立刻退出）：
#   1. db.background-tasks.test.ts             —— enqueue / claim / heartbeat /
#                                                 recover / cancel 全路径 + lease 严格校验
#   2. tasks/scheduler.test.ts                 —— BackgroundTaskScheduler tick / reaper /
#                                                 handler crash retry / 重入串行化
#   3. cli/tasks.test.ts                       —— pin tasks list/show/attempts/cancel/enqueue
#                                                 envelope 形状 + 输入校验
#   4. tasks/handlers/connector-init.test.ts   —— Gmail + GCal 全链路 (mock Composio):
#                                                 fetch → raw → signals → evolution_run
#                                                 + refs_consumed; 含 Phase B.1 evolve 集成
#   5. tasks/handlers/connector-evolve.test.ts —— Phase B.1 evolve 单元: prompt 采样 /
#                                                 LLM 失败兜底 / 输出 sanitization /
#                                                 memory_write + delta + refs_produced
#   6. tasks/handlers/auto-dreaming.test.ts    —— Phase C 处理器: dreamRunner 注入 /
#                                                 dream throw / max_attempts=1 / lease 心跳
#   7. tasks/dreaming-enqueuer.test.ts         —— Phase C 入队器: setting/due 检查 /
#                                                 时区按 profile / 同一 local_day 幂等
#   8. tasks/reconciler.test.ts                —— ACTIVE 扫描 + 幂等 + 失败兜底
#   9. routes/composio.test.ts                 —— /composio/wait → enqueue 钩子
#
# 另：scheduler/auto-loop.test.ts 含 Phase C gate 回归（runAutoDreaming 在
# BACKGROUND_AUTO_LOOP_TASKS_ENABLED=1 时必须 no-op），由 test-memory.sh 跑到。
#
# 这套脚本和 test-memory.sh 的关系：
# - test-memory.sh 守 v3 memory/personal_signals/evolution_runs/auto-loop 的契约。
# - test-tasks.sh  守 background_tasks 队列 + scheduler + connector.init/evolve +
#                    auto.dreaming + CLI + 钩子。
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
run "[1/9] schema + repository" \
  db.background-tasks.test.ts
run "[2/9] scheduler tick + handler" \
  tasks/scheduler.test.ts
run "[3/9] pin tasks CLI" \
  cli/tasks.test.ts

# ─── Phase B + B.1：connector.init + evolve + 接线 ─────────────────────────
run "[4/9] connector.init handler (Gmail + GCal, mock Composio)" \
  tasks/handlers/connector-init.test.ts
run "[5/9] connector-evolve (LLM-injected fact extraction)" \
  tasks/handlers/connector-evolve.test.ts

# ─── Phase C：auto.dreaming on scheduler ──────────────────────────────────
run "[6/9] auto.dreaming handler" \
  tasks/handlers/auto-dreaming.test.ts
run "[7/9] dreaming-enqueuer (daily-due idempotent enqueue)" \
  tasks/dreaming-enqueuer.test.ts

# ─── 接线 ─────────────────────────────────────────────────────────────────
run "[8/9] reconciler" \
  tasks/reconciler.test.ts
run "[9/9] /composio/wait → enqueue hook" \
  routes/composio.test.ts

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "✅ background_tasks (Phase A + B + B.1 + C) 全部测试通过。"
echo "   九层（schema/repo / scheduler / CLI / connector.init / evolve / "
echo "         auto.dreaming handler / dreaming-enqueuer / reconciler / wait-hook）都没断。"
echo "──────────────────────────────────────────────────────────────────────"
