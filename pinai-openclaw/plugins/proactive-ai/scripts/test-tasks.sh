#!/usr/bin/env bash
# 一键回归 background_tasks 模块（Phase A：scheduler 基建 + CLI）
#
# 用法：
#   bash pinai-openclaw/plugins/proactive-ai/scripts/test-tasks.sh
#
# 三层覆盖（顺序很重要，先 schema 再 scheduler 再 CLI）：
#   1. db.background-tasks.test.ts          —— enqueue / claim / heartbeat /
#                                              recover / cancel 全路径 + lease 严格校验
#   2. tasks/scheduler.test.ts              —— BackgroundTaskScheduler tick / reaper /
#                                              handler crash retry / 重入串行化
#   3. cli/tasks.test.ts                    —— pin tasks list/show/attempts/cancel/enqueue
#                                              envelope 形状 + 输入校验
#
# 任意一步红就立刻退出，方便定位最早断在哪一层。
#
# 这套脚本和 test-memory.sh 的关系：
# - test-memory.sh 守 v3 memory/personal_signals/evolution_runs 的契约。
# - test-tasks.sh  守 background_tasks 队列 + scheduler + pin tasks CLI。
# - 两套各自独立可跑；CI 里都过才算 Phase A 验收通过。

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

# ─── 1. schema + repository ───────────────────────────────────────────────
run "[1/3] schema + repository" \
  db.background-tasks.test.ts

# ─── 2. scheduler tick / handler / reaper ─────────────────────────────────
run "[2/3] scheduler tick + handler" \
  tasks/scheduler.test.ts

# ─── 3. pin tasks CLI ─────────────────────────────────────────────────────
run "[3/3] pin tasks CLI" \
  cli/tasks.test.ts

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "✅ background_tasks (Phase A) 全部测试通过。"
echo "   schema/repo / scheduler / CLI 三层都没断。"
echo "──────────────────────────────────────────────────────────────────────"
