#!/usr/bin/env bash
# Import-boundary checks, both of which ruff banned-api can't enforce here
# (the agent-engine subtree is blanket TID251-ignored as the sibling-import
# escape hatch — see pyproject.toml):
#   (1) trust boundary  — web ↔ agent-engine process groups must not import
#       each other
#   (2) facade boundary — engine's agents/tools/transport must not import
#       deepagents top-level / langgraph; that goes through harness/.
#
# Phase 5: the agent-engine is a standalone uv workspace package
# (services/agent-engine, agent_engine) that depends only on
# pinai-contracts, never on backend (web). The trust boundary is
# enforced physically by the dependency graph; this grep + import-linter
# are the second + third lines of defense.
#
# Trust-boundary directional check. Catches absolute cross-package imports
# that survive a refactor:
#   - engine source importing from pinai_api (the master-credential package)
#   - pinai_api/foo.py importing from agent_engine (the LLM-loop package)
#   - libs/contracts/**.py importing from either side
#
# Run: bash scripts/check_trust_boundary.sh
# CI: hook into Makefile / GitHub Actions before ruff.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

engine_src="services/agent-engine/src/agent_engine"

# engine → pinai_api (the master-credential package) violation. The engine
# is a separate package and must not reach into it at all.
if grep -rE '^from pinai_api|^import pinai_api' "$engine_src/" 2>/dev/null; then
  echo "❌ agent-engine files cannot import pinai_api — that's the master-credential package."
  echo "   engine depends only on pinai-contracts; cross-process calls go over HTTPS + EdDSA JWT."
  echo "   See docs/plans/2026-06-21-backend-rearchitecture.mdx § trust 边界."
  fail=1
fi

# api/ → engine violation
if grep -rE '^from agent_engine|^import agent_engine' services/api/src/pinai_api/ 2>/dev/null; then
  echo "❌ pinai_api files cannot import agent_engine — that's the LLM-loop process."
  echo "   See docs/plans/2026-06-21-backend-rearchitecture.mdx § trust 边界."
  fail=1
fi

# contracts (libs/contracts) must not import either side — it's the
# workspace leaf package shared by api and engine.
if grep -rE '^from (pinai_api|agent_engine)|^import (pinai_api|agent_engine)' libs/contracts/src/pinai_contracts/ 2>/dev/null; then
  echo "❌ pinai_contracts files cannot import api/ or engine — contracts is for pure model + protocol only."
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
  if grep -rnE '^[[:space:]]*(from deepagents import|import deepagents$|from langgraph|import langgraph)' "$engine_src/$layer/" 2>/dev/null; then
    echo "❌ agent-engine $layer/ must not import deepagents top-level / langgraph —"
    echo "   route through harness/ (build_agent / read_state_messages / stream_events / get_checkpointer)."
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "✓ trust + facade boundaries clean"
fi
exit "$fail"
