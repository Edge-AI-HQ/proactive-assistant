#!/usr/bin/env bash
# Import-boundary checks, both of which ruff banned-api can't enforce here
# (chat/** is blanket TID251-ignored as the sibling-import escape hatch —
# see pyproject.toml):
#   (1) trust boundary  — web ↔ chat process groups must not import each other
#   (2) facade boundary — chat's agents/tools/transport must not import
#       deepagents top-level / langgraph; that goes through harness/.
#
# Trust-boundary directional check.
#
# Greps the source tree for cross-process-group imports that ruff
# banned-api can't enforce on its own (it doesn't distinguish
# "chat → web" from "chat → chat" once relative imports resolve).
#
# Catches the patterns code review can miss:
#   - chat/foo.py importing from pinai_agents.web (absolute)
#   - web/foo.py importing from pinai_agents.chat (absolute)
#   - shared/foo.py importing from either side
#
# Relative imports inside chat/ / web/ aren't visible to this check —
# but they also can't reach the other process group (`from ..web` from
# chat/foo.py would look for web/ inside chat/, doesn't exist).
#
# Run: bash scripts/check_trust_boundary.sh
# CI: hook into Makefile / GitHub Actions before ruff.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

# chat/ → web/ violation
if grep -rE '^from pinai_agents\.web|^import pinai_agents\.web' src/pinai_agents/chat/ 2>/dev/null; then
  echo "❌ chat/ files cannot import pinai_agents.web — that's the master-credential process."
  echo "   See docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx § trust 边界."
  fail=1
fi

# web/ → chat/ violation
if grep -rE '^from pinai_agents\.chat|^import pinai_agents\.chat' src/pinai_agents/web/ 2>/dev/null; then
  echo "❌ web/ files cannot import pinai_agents.chat — that's the LLM-loop process."
  echo "   See docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx § trust 边界."
  fail=1
fi

# shared/ must not import either side
if grep -rE '^from pinai_agents\.(web|chat)|^import pinai_agents\.(web|chat)' src/pinai_agents/shared/ 2>/dev/null; then
  echo "❌ shared/ files cannot import web/ or chat/ — shared is for pure model + protocol only."
  fail=1
fi

# ── facade boundary (plan 2026-06-02 §PR-C) ──
# agents / tools / transport must not import deepagents top-level symbols
# (create_deep_agent, SubAgent, …) or langgraph. Agent construction goes
# through harness.factory.build_agent; state reads/writes through
# harness.session; checkpointer through harness.checkpoint. harness/ is the
# facade and is exempt. `deepagents.backends.*` (the sandbox backend adapter
# used by tools/code_mode/local_sandbox) is matched by neither pattern below.
for layer in agents tools transport; do
  if grep -rnE '^[[:space:]]*(from deepagents import|import deepagents$|from langgraph|import langgraph)' "src/pinai_agents/chat/$layer/" 2>/dev/null; then
    echo "❌ chat/$layer/ must not import deepagents top-level / langgraph —"
    echo "   route through harness/ (build_agent / read_state_messages / stream_events / get_checkpointer)."
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "✓ trust + facade boundaries clean"
fi
exit "$fail"
