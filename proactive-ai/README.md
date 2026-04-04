# Proactive AI (v2)

OpenClaw plugin that generates Intent Cards — AI-powered "next best action" recommendations based on user profile, goals, personal context, and world events.

## Prerequisites

- [OpenClaw](https://docs.openclaw.ai) installed and running (with `tools.profile: "coding"`)
- [pin-cli](../pin-cli/) built and globally linked:

```bash
# From repo root
npm install --workspace pin-cli
npm run build --workspace pin-cli
npm link --workspace pin-cli

# Verify
pin sys doctor --json
```

## Install

```bash
# Register the plugin and install gateway (from repo root)
openclaw plugins install -l ./proactive-ai && openclaw gateway install

# Or if already installed, restart to pick up changes
openclaw gateway restart
```

## Usage

### Web UI

Open in browser:

```
http://127.0.0.1:<gateway-port>/proactive-ai
```

Find your gateway port:

```bash
grep '"port"' ~/.openclaw/openclaw.json
```

Click **"Generate Intent Cards"** to trigger the pipeline. Results stream in via SSE.

### Chat Command

In any OpenClaw chat session:

```
/generate
```

### API

```bash
# Health check
curl http://127.0.0.1:<port>/proactive-ai/api/health

# Trigger pipeline (SSE stream)
curl http://127.0.0.1:<port>/proactive-ai/api/generate

# Custom iteration count
curl http://127.0.0.1:<port>/proactive-ai/api/generate?iterations=3
```

## How It Works

The pipeline runs a **Planner -> Generator -> Evaluator** loop (default 3 iterations):

```
Planner   reads user profile/goals/context via pin-cli
          outputs: which Intent Cards to generate and why
              |
Generator takes the plan, gathers detailed data via pin-cli
          outputs: fully-formed Intent Cards
              |
Evaluator scores each card on 5 dimensions (0-10):
          relevance, actionability, whyNowClarity, novelty, decisionCompression
          pass threshold: overall >= 7.0
          outputs: scores + improvement feedback
              |
          If more iterations: structured context feeds back to Planner
```

### Cross-Iteration Context

When running multiple iterations, each round gets the full context from the previous:

| Agent | Receives from previous iteration |
|-------|----------------------------------|
| Planner | feedback + previous plan + previous cards + per-card scores |
| Generator | feedback + previous cards + per-card scores |
| Evaluator | (always evaluates fresh — no carryover needed) |

This lets agents make targeted improvements: low actionability scores → more concrete actions, low novelty → find new data sources, etc.

### Card Selection

After all iterations complete, cards are selected from a cross-iteration candidate pool:

1. **Filter** — only cards that passed evaluation (overall >= 7.0)
2. **Sort** — by Evaluator's `overall` score (5-dimension average), not Generator's self-reported confidence
3. **Diversify** — max 2 cards per goal basket (work/health/family/wealth/growth/life)
4. **Top 5** — final output
5. **Fallback** — if nothing passes 7.0, take the highest-scoring cards anyway

## Configuration

In `~/.openclaw/openclaw.json`, under plugin config:

| Key | Default | Description |
|-----|---------|-------------|
| `max_iterations` | `3` | Planner/Generator/Evaluator loop count |
| `agent_timeout_ms` | `300000` | Timeout per agent (5 min) |

## Project Structure

```
proactive-ai/
  index.ts                    # Plugin entry (command + HTTP routes)
  openclaw.plugin.json        # Plugin manifest (skills: ./skills/)
  skills/                     # pin-cli skill docs (loaded by OpenClaw agents)
    pin-shared/SKILL.md       # Output contract, safety rules, introspection
    pin-profile/SKILL.md      # User profile, goals, preferences, memory
    pin-personal/SKILL.md     # Third-party data via Composio MCP
    pin-world/SKILL.md        # News, headlines, world events
    pin-feedback/SKILL.md     # Intent Card response tracking
    pin-push/SKILL.md         # Push dedup and delivery tracking
  src/
    agents/
      planner.ts              # Planner agent system prompt
      generator.ts            # Generator agent system prompt
      evaluator.ts            # Evaluator agent system prompt
    pipeline/
      orchestrator.ts         # Planner->Generator->Evaluator loop + card selection
      pin-cli.ts              # Shell exec wrapper for `pin` commands
    types/
      intent-card.ts          # IntentCard, PipelineResult, EvaluationScore, etc.
      openclaw.d.ts           # OpenClaw SDK type stubs
    ui/
      index.html              # Placeholder frontend (will be replaced)
```

## Pin CLI Integration

Agents access user data by executing `pin` CLI commands via OpenClaw's built-in `exec` tool. The plugin registers skill files (under `./skills/`) that teach agents the full command reference.

`pin` must be available on `$PATH` (see Prerequisites).

## Development

```bash
# Type-check
cd proactive-ai && npx tsc --noEmit

# After code changes, restart gateway to reload
openclaw gateway restart
```

No build step needed — OpenClaw uses jiti for runtime TypeScript compilation.
