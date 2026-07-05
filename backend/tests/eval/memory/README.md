# Memory retrieval eval (design §十 P0)

The regression set that proves the memory layer didn't get *worse*. Design §十 makes
this **P0 — the first thing built**: "固定问题集 + 人工 ground truth + 不可篡改",
because every later change (objective ranking, formation gating, rollup, the L0
contract) is only safe if we can show retrieval quality held.

This is the **harness skeleton**. It runs today on synthetic fixtures; the real
value lands when real ground truth is filled in (collection strategy is still open
— design §八.1 onboarding-seed note).

## Layout

```
tests/eval/memory/
  metrics.py        # recall@k / precision@k / mrr / ndcg@k — pure, frozen
  harness.py        # YAML fixture → dataclasses → score(); DB-free
  fixtures/*.yaml    # the ANSWER KEY (ground truth) — checked in
  test_metrics.py    # unit tests for the metrics (no DB)
  test_retrieval.py  # seeds events in the test DB, runs events_search, scores
```

## Running

The retrieval eval needs the pgvector test DB (same as the rest of `tests/web`):

```bash
export TEST_DATABASE_URL="postgresql+psycopg://postgres:postgres@localhost:5433/postgres"
export TAVILY_API_KEY=dummy
uv run pytest tests/eval/memory -p no:cacheprovider -q
```

`test_metrics.py` runs anywhere (no DB). `test_retrieval.py` seeds each fixture's
events via `EventsRepository`, runs the real `events_search`, and asserts every
query clears its fixture thresholds.

## Adding ground truth

1. Drop a `fixtures/<name>.yaml`. Schema:
   ```yaml
   name: <id>
   description: <what this probes>
   seed_events:                 # AppendEventInput kwargs
     - {id, event_type, title, occurred_at, curated: true, reference_count?: N}
   queries:
     - name: <id>
       params: {event_type?, since?, until?, q?, limit?, with_run_id?: true}
       expected_ids: [<ground-truth relevant ids, ideal order>]
       thresholds: {recall@10: 1.0, mrr: 1.0, "ndcg@10": 1.0}   # the gate
   ```
   - `with_run_id: true` → the agent-retrieval path (objective ranking by
     reference × recency × event_type × similarity). Omit for the UI/internal
     path (occurred_at DESC).
   - `reference_count` on a seed event is stamped onto the row after append (it's
     normally bumped by retrieval; seeded directly here to pin ranking behaviour).
   - `q` drives semantic search — needs an embedding backend (`LITELLM_*`); skip
     `q` fixtures in environments without it.

2. The harness sha256s the answer key into the run output. A fixture diff is a
   change to the eval's verdict — **review it like a changed test assertion**.
   Tamper-*evidence*, not tamper-proofing: the point is a reviewer can see it.

## What it does NOT cover yet

- **Portrait drift / forgetting** eval (does evolve keep the right facts, evict the
  stale ones) — needs a longitudinal fixture format + real ground truth.
- **Real ground truth** — the synthetic fixtures only prove the harness runs and
  the structured/reference contracts hold. Real user-labelled sets replace them.
