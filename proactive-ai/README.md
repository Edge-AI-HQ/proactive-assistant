# Proactive AI (v2)

AI-powered "next best action" recommendations based on user profile, goals, personal context, and world events. Runs as a macOS desktop app powered by OpenClaw.

## Quick Start

```bash
# Prerequisites: Node.js 22.12+ and OpenClaw installed globally
nvm use 22
npm install -g openclaw

# From repo root
cd proactive-ai/electron
npm run setup && npm run dev
```

On first launch, the app will:
1. Create an isolated OpenClaw profile at `~/.openclaw-proactive-ai/`
2. Prompt for your Anthropic API key (if not configured)
3. Start the OpenClaw gateway and open the Proactive AI UI

## Development

```bash
# Rebuild UI after frontend changes
cd proactive-ai
npm run build:ui

# Rebuild + launch Electron
cd electron
npm run dev

# UI dev server with hot reload (optional — for faster frontend iteration)
cd proactive-ai
PROACTIVE_AI_PROXY_TARGET=http://127.0.0.1:<gateway-port> \
PROACTIVE_AI_GW_TOKEN=<token> \
npm run dev:ui
# Then open http://localhost:8080
```

The gateway token is printed to the terminal when the Electron app starts.

## How It Works

The pipeline runs a **Planner -> Generator -> Evaluator** loop (default 2 iterations):

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

### Card Selection

After all iterations complete, cards are selected from a cross-iteration candidate pool:

1. **Filter** — only cards that passed evaluation (overall >= 7.0)
2. **Sort** — by Evaluator's `overall` score (5-dimension average)
3. **Diversify** — max 3 cards per goal basket (work/health/family/wealth/growth/life)
4. **Top 10** — final output
5. **Fallback** — if nothing passes 7.0, take the highest-scoring cards anyway

## Project Structure

```
proactive-ai/
  index.ts                    # OpenClaw plugin entry (commands + HTTP routes)
  openclaw.plugin.json        # Plugin manifest
  vite.config.ts              # Vite build config (React UI → single-file HTML)
  skills/                     # pin-cli skill docs (loaded by OpenClaw agents)
    pin-shared/SKILL.md
    pin-profile/SKILL.md
    pin-personal/SKILL.md
    pin-world/SKILL.md
    pin-feedback/SKILL.md
    pin-push/SKILL.md
  src/
    agents/                   # Agent system prompts (planner, generator, evaluator, chat)
    pipeline/                 # Orchestrator loop + pin-cli wrapper
    types/                    # TypeScript types + OpenClaw SDK stubs
    ui/                       # React frontend (Vite + Tailwind + shadcn)
      App.tsx                 # Root component
      components/             # AppLayout, NowFeed, CardChat, GoalsView, etc.
      hooks/                  # use-pipeline, use-composio
      lib/                    # API helpers
      assets/                 # Images
  electron/                   # Desktop app shell
    main.ts                   # Electron main process (gateway lifecycle, IPC)
    gateway.ts                # OpenClaw gateway spawn + health polling
    setup.ts                  # First-run profile setup + config management
    config.ts                 # API key read/write (auth-profiles.json)
    preload.ts                # IPC bridge for renderer
    forge.config.ts           # electron-forge build config (DMG/ZIP)
```

## Configuration

Data is stored at `~/.openclaw-proactive-ai/` (isolated from any existing OpenClaw install).

| Key | Default | Description |
|-----|---------|-------------|
| `max_iterations` | `2` | Planner/Generator/Evaluator loop count |
| `agent_timeout_ms` | `300000` | Timeout per agent (5 min) |
