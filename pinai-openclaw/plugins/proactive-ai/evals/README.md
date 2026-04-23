# Proactive AI evals harness

Off-line + on-line measurement for the recommendation pipeline.

## Why

The unified-generator agent now reads from the v3 retrieval layer
(`pin memory list`, `pin signals recent`, `pin raw gmail recent`, …).
Every change to the prompt, retrieval boundaries, or memory consolidation
strategy needs to answer two questions:

1. **Did card quality go up or down?** (5-dimension self-eval + human label)
2. **Did the agent get faster / cheaper / more reliable?** (latency, tokens,
   timeout rate)

This harness is the answer.

## Layout

```
evals/
├── README.md                    you are here
├── fixtures/
│   ├── personas/                ContextPack snapshots for synthetic users
│   └── golden/                  human-labelled (ContextPack, Card, score) triples
├── scorers/
│   ├── auto.ts                  LLM (Sonnet) reproduces the 5-dim rubric
│   └── human.ts                 import CSV from manual labelling sessions
├── runner/
│   ├── replay.ts                run a fixture set through the live prompt + collect outputs
│   └── diff.ts                  baseline_run.json vs candidate_run.json → metrics
└── metrics/
    ├── card-quality.ts          mean dim_relevance / dim_actionability / ...
    ├── pipeline-health.ts       p50 / p95 latency, timeout rate, llm_tokens
    └── online.ts                reads card_evaluations + feedback_events from a
                                 real DB and computes confirm/dismiss rate per basket
```

## Quick start

```bash
# Run the offline eval against the current prompt
npx tsx pinai-openclaw/plugins/proactive-ai/evals/runner/replay.ts \
  --fixtures evals/fixtures/golden \
  --out evals/runs/baseline-2026-04-23.json

# After changing the prompt, run again
npx tsx ... --out evals/runs/candidate-2026-04-23.json

# Diff
npx tsx pinai-openclaw/plugins/proactive-ai/evals/runner/diff.ts \
  --baseline evals/runs/baseline-2026-04-23.json \
  --candidate evals/runs/candidate-2026-04-23.json
```

## Online metrics

The `card_evaluations` table is populated by the orchestrator (Phase 1
of the v3 rollout). The `online.ts` scorer joins it against
`feedback_events` to compute:

- confirm rate per `basket` over a 7d / 14d window
- dismiss rate per `basket`
- pass-rate distribution of `card_evaluations.overall`
- correlation between `dim_relevance` (self-eval) and human confirm

Run via:

```bash
pin evolution recent --limit 50    # spot-check trajectory
pin cards recent --limit 100       # spot-check generated card stream
```

## Golden set

`fixtures/golden/` should hold ~200-300 hand-labelled triples. Schema:

```jsonl
{"id":"g-001","contextPack":{...snapshot of pin retrieval outputs...},
 "card":{...generated card...},
 "labels":{"relevance":8.5,"actionability":7,"whyNow":8,"novelty":7,"decisionCompression":8.5,"overall":7.8,"pass":true,"reviewer":"smile@pinai.io"}}
```

Build the golden set incrementally: add 10-20 cards per week from the
real production stream, label them, commit the JSONL.

## Status

This harness is **scaffolding only** — runner + scorers are stubs that
return shaped-but-not-meaningful data. Real implementation will land in
its own PR after the v3 storage layer has run in dev for a week.

See [`docs/memory-architecture.md`](../../../../docs/memory-architecture.md) §八 (阶段实施).
