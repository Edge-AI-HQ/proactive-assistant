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

### Electron Runtime (no hot reload)

```bash
# Build the current UI bundle once, compile Electron, then launch the desktop app
cd electron
npm run dev
```

`npm run dev` in `proactive-ai/electron` does **not** provide frontend hot reload.
It builds the current UI bundle once, compiles the Electron main process, then launches Electron against the OpenClaw gateway UI.

If you change frontend code and want to see it in the Electron window, rebuild the UI and relaunch Electron.

### Frontend HMR + Gateway Proxy

Use this mode for fast frontend iteration. Electron launches the OpenClaw gateway, starts the Vite dev server for the renderer, and injects the gateway URL/token automatically.

```bash
# One command: Electron + gateway + renderer HMR
cd proactive-ai/electron
npm run dev:hmr
```

Notes:
- Renderer/frontend changes hot reload in the Electron window.
- Electron main-process / preload changes still require restarting `npm run dev:hmr`.
- By default the renderer dev server uses a random free localhost port. Set `PROACTIVE_AI_UI_DEV_SERVER` to pin it to a specific URL if needed.

The gateway URL and token are printed to the terminal when the Electron app starts.

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
