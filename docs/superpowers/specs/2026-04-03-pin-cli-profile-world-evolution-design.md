# PIN CLI Profile/World Evolution Design

## Summary

This design narrows `pin-cli` to the two domains owned by this workstream: `profile` and `world`.

The goal is not to embed AI inside the CLI. The goal is to make the CLI the deterministic data plane that lets agents improve recommendation quality over time without blowing up context size.

The design centers on four principles:

- `world` stores normalized world events, not source-specific blobs.
- `profile` stores stable user features, not a single growing JSON document.
- learning happens through deterministic `signal -> rollup -> interests -> snapshot`.
- agent-facing reads default to compressed views, not full raw state.

## Goals

- Improve recommendation precision over repeated user interactions.
- Keep `pin-cli` deterministic and local-first.
- Support rich `world` sources such as tech news, finance news, market events, and calendars.
- Make agent reads context-efficient by default.
- Preserve enough auditability to explain why interests shifted or why an item was shortlisted.

## Non-Goals

- No LLM calls inside `pin-cli`.
- No attempt to let the CLI directly decide final recommendation copy.
- No dependence on `apis`.
- No general-purpose orchestration domain in this design.
- No attempt to solve every external source in v1.

## Context And Constraints

- `pin-cli/CODING.md` forbids embedded AI in CLI commands.
- The product needs to get better over time, which requires stable intermediate representations rather than repeated full-text re-analysis.
- The long-term failure mode is context bloat: full profile reads, large memory blobs, and large world result sets.
- Recommendation quality depends more on normalized structure and feedback rollup than on adding ad hoc commands.

## Approaches Considered

### Option A: Put AI inside `pin-cli`

Commands would directly summarize, infer interests, or pick recommendations.

Pros:

- fewer steps for the caller
- superficially convenient

Cons:

- violates the current CLI contract
- weakens determinism and replayability
- makes testing and debugging much harder
- pushes prompt and model drift into the tool layer

### Option B: Deterministic CLI with explicit learning primitives

The CLI exposes normalized storage, structured enrichment, signal ingestion, rollup, compression, and shortlist/context views. Agents remain responsible for model-based reasoning.

Pros:

- fits existing CLI rules
- keeps learning auditable
- supports iterative tuning of weights and filters
- makes context control an explicit feature

Cons:

- requires more command design up front
- agents must call multiple commands instead of one magical command

### Option C: Store everything as large JSON blobs and let the agent interpret them

Pros:

- fastest short-term implementation

Cons:

- context usage degrades over time
- poor indexing and poor explainability
- hard to do selective retrieval, rollup, or compaction

## Decision

Choose Option B.

`pin-cli` remains deterministic. `world` becomes a normalized event stream. `profile` becomes a structured learning surface. Rule-based rollup updates stable interests from raw signals. Agent-facing commands produce short, targeted views instead of full raw state.

## Architecture

The recommendation learning loop is:

1. `world` ingests and normalizes source data.
2. `world` stores structure such as topics, entities, domain, event type, and duplicate/event clusters.
3. `world shortlist` produces a deterministic coarse candidate set for a given profile.
4. The agent reasons over that small set and interacts with the user.
5. User reactions are translated into `profile signals`.
6. `profile signal rollup` updates stable `profile interests`.
7. `profile snapshot build` emits compact profile views for the next round.

The key boundary is:

- CLI: deterministic structure, scoring inputs, compression, aggregation
- Agent: model-based interpretation, selection, wording, follow-up reasoning

## World Domain

### Purpose

`world` is the normalized store for external events that might matter to the user. It should support richer source coverage than the current Google News RSS-only implementation, but all sources must converge to one standard item shape.

### Canonical `world item`

Each ingested item should normalize to the following conceptual shape:

```json
{
  "id": "w_01hxxx",
  "source": {
    "type": "news",
    "provider": "google-news",
    "channel": "rss",
    "external_id": "abc123",
    "url": "https://example.com/article",
    "normalized_url": "https://example.com/article"
  },
  "content": {
    "title": "OpenAI releases new agent tooling",
    "summary": "Short normalized summary",
    "body": null,
    "language": "en",
    "published_at": "2026-04-03T08:00:00.000Z",
    "updated_at": "2026-04-03T08:10:00.000Z"
  },
  "classification": {
    "domain": "tech",
    "topics": ["ai", "agents", "developer-tools"],
    "entities": [
      { "type": "company", "name": "OpenAI" }
    ],
    "region": "global",
    "importance": "high",
    "event_type": "product_launch"
  },
  "ranking": {
    "freshness_score": 0.91,
    "quality_score": 0.8,
    "novelty_score": 0.72,
    "duplicate_cluster_id": "c_01hyyy"
  },
  "metadata": {
    "search_queries": ["openai agents"],
    "tags": ["llm", "api"],
    "raw": {}
  }
}
```

### Source Coverage

The schema must support at least these `source.type` values:

- `news`
- `market`
- `calendar`
- `social`
- `creator`
- `document`
- `watchlist`
- `signal`

This allows finance to be more than just business headlines. For example:

- `news`: market commentary, company coverage, macro news
- `market`: price moves, volume spikes, earnings surprises
- `calendar`: earnings dates, policy events, product launches
- `document`: SEC filings, policy notices, official company releases

### World Storage

The world model should be split into four tables.

#### `world_items`

Stores canonical items.

Key fields:

- `id`
- `source_type`
- `provider`
- `channel`
- `external_id`
- `url`
- `normalized_url`
- `title`
- `summary`
- `body`
- `language`
- `domain`
- `region`
- `event_type`
- `importance`
- `published_at`
- `updated_at`
- `ingested_at`
- `freshness_score`
- `quality_score`
- `novelty_score`
- `duplicate_cluster_id`
- `search_queries`
- `topics`
- `metadata`
- `raw_payload`

#### `world_entities`

Stores item-linked entities for fast retrieval.

Key fields:

- `id`
- `world_item_id`
- `entity_type`
- `name`
- `normalized_name`
- `symbol`
- `metadata`

#### `world_clusters`

Stores duplicate clusters and broader event clusters.

Key fields:

- `id`
- `kind` (`duplicate` or `event`)
- `title`
- `summary`
- `domain`
- `topic`
- `created_at`
- `updated_at`
- `metadata`

#### `world_item_links`

Stores relationships across items.

Key fields:

- `id`
- `from_item_id`
- `to_item_id`
- `link_type` (`duplicate_of`, `related`, `followup`, `evidence`, `contradiction`)
- `score`
- `created_at`
- `metadata`

### World Command Surface

#### `pin world ingest`

```bash
pin world ingest --source-type news --provider google-news --items-json '<json>' --json
```

Purpose:

- single write entrypoint for adapters
- normalize many source shapes into canonical items
- keep source-specific fetching logic separate from canonical storage

Writes:

- `world_items`
- optionally `world_entities` if provided in the input payload

Supports:

- `--dry-run`

#### `pin world enrich`

```bash
pin world enrich --id <id> \
  --topics-json '["ai","agents"]' \
  --entities-json '[{"type":"company","name":"OpenAI"}]' \
  --domain tech \
  --event-type product_launch \
  --importance high \
  --json
```

Purpose:

- write structured enrichment back to an existing world item
- accept agent-produced or rule-produced structure without making the CLI perform inference

Writes:

- `world_items.topics`
- `world_items.domain`
- `world_items.event_type`
- `world_items.importance`
- `world_entities`

Supports:

- `--dry-run`

#### `pin world cluster`

```bash
pin world cluster --since 2026-04-01T00:00:00.000Z --json
```

Purpose:

- merge duplicate coverage
- create event clusters for follow-up stories

Writes:

- `world_clusters`
- `world_item_links`
- `world_items.duplicate_cluster_id`

Supports:

- `--dry-run`

#### `pin world related`

```bash
pin world related --id <id> --limit 10 --json
```

Purpose:

- fetch nearby items from duplicate/event clusters or explicit links
- let the agent get supporting context without scanning the full corpus

#### `pin world shortlist`

```bash
pin world shortlist --profile-id default --limit 20 --json
```

Purpose:

- produce a deterministic coarse candidate set
- filter and rank by stable signals before the agent does final reasoning

Inputs:

- `profile_interests`
- profile constraints and suppressed dislikes
- `world` freshness, importance, novelty, duplication state

Outputs:

- compact candidate records with deterministic scores and reasons

#### `pin world context`

```bash
pin world context --ids <id1,id2,...> --view compact --json
```

Purpose:

- produce a context-efficient read for the agent
- default to compact views rather than full bodies

Views:

- `compact`: title, summary, topics, entities, cluster, importance, key scores
- `brief`: compact plus a few related items
- `full`: opt-in only, includes `body`

#### `pin world entity search`

```bash
pin world entity search --name OpenAI --json
pin world entity search --symbol NVDA --json
```

Purpose:

- support entity-centric recommendation and monitoring

#### `pin world compact`

```bash
pin world compact --before 2026-03-01T00:00:00.000Z --json
```

Purpose:

- compress older data
- keep cluster summaries and key structure while trimming low-value long text

### World Write Ownership

Fields that must come from deterministic adapters or repository logic:

- `id`
- `source_type`
- `provider`
- `channel`
- `external_id`
- `url`
- `normalized_url`
- `title`
- `published_at`
- `ingested_at`

Fields that may be supplied by the agent or by deterministic enrichment:

- `summary`
- `topics`
- `entities`
- `domain`
- `event_type`
- `importance`

Fields that should stay system-computed:

- `freshness_score`
- `novelty_score`
- duplicate and cluster assignments

## Profile Domain

### Purpose

`profile` is the structured learning surface for recommendation quality. It should store stable identity separately from evolving interests, memories, and raw behavior signals.

### Profile Storage

The profile model should be split into five tables.

#### `profiles`

Stores stable identity and stable metadata.

Key fields:

- `id`
- `display_name`
- `locale`
- `timezone`
- `summary`
- `metadata`
- `created_at`
- `updated_at`

#### `profile_interests`

Stores stable and semi-stable interest features.

Key fields:

- `id`
- `profile_id`
- `kind` (`topic`, `entity`, `source`, `domain`, `format`)
- `key`
- `score`
- `confidence`
- `evidence_count`
- `last_signal_at`
- `status` (`active`, `suppressed`, `archived`)
- `metadata`
- `created_at`
- `updated_at`

#### `profile_memories`

Stores user facts, constraints, and agent-observed memories with explicit scope.

Key fields:

- `id`
- `profile_id`
- `kind` (`fact`, `preference`, `behavior`, `inference`, `constraint`)
- `scope` (`stable`, `recent`, `temporary`)
- `text`
- `summary`
- `tags`
- `source`
- `salience`
- `valid_until`
- `created_at`
- `updated_at`
- `metadata`

#### `profile_signals`

Stores raw learning signals.

Key fields:

- `id`
- `profile_id`
- `kind` (`opened`, `skipped`, `liked`, `disliked`, `followed_up`, `searched`, `shared`)
- `target_type` (`topic`, `entity`, `domain`, `source`, `world_item`)
- `target_key`
- `value`
- `source` (`explicit`, `implicit`, `agent`)
- `occurred_at`
- `context`
- `metadata`

#### `profile_snapshots`

Stores compact profile views for agent consumption.

Key fields:

- `id`
- `profile_id`
- `view` (`ranking`, `briefing`, `exploration`)
- `content`
- `generated_at`
- `expires_at`
- `metadata`

### Profile Command Surface

#### `pin profile signal add`

```bash
pin profile signal add \
  --id default \
  --kind opened \
  --target-type topic \
  --target-key ai \
  --value 0.4 \
  --source implicit \
  --json
```

Purpose:

- accept explicit and implicit feedback as normalized learning events
- make raw learning evidence queryable and replayable

Supports:

- `--dry-run`

#### `pin profile signal rollup`

```bash
pin profile signal rollup --id default --since 30d --json
```

Purpose:

- deterministically convert raw signals into stable interests
- keep learning explainable and testable

Outputs:

- signals processed
- interests updated
- top positive and negative shifts
- drift detection summary

Supports:

- `--dry-run`

#### `pin profile interests list`

```bash
pin profile interests list --id default --kind topic --limit 20 --json
```

Purpose:

- fetch stable interests without reading all raw signals

#### `pin profile interests upsert`

```bash
pin profile interests upsert \
  --id default \
  --kind entity \
  --key OpenAI \
  --score 0.9 \
  --confidence 0.8 \
  --json
```

Purpose:

- allow explicit correction or seeding of interest weights

Supports:

- `--dry-run`

#### `pin profile dislikes add`

```bash
pin profile dislikes add --id default --kind topic --key celebrity-gossip --json
```

Purpose:

- make strong negative preferences first-class rather than weak low scores

Supports:

- `--dry-run`

#### `pin profile memory add`

```bash
pin profile memory add \
  --id default \
  --kind inference \
  --scope recent \
  --text "User appears more interested in AI tooling than general startup news" \
  --summary "Prefers AI tooling" \
  --tags-json '["ai","tooling"]' \
  --json
```

Purpose:

- store explainable agent observations and inferences
- distinguish stable facts from temporary inferences

Supports:

- `--dry-run`

#### `pin profile memory compact`

```bash
pin profile memory compact --id default --json
```

Purpose:

- merge repetitive or low-value memories
- keep profile context small over time

Supports:

- `--dry-run`

#### `pin profile snapshot build`

```bash
pin profile snapshot build --id default --view ranking --json
```

Purpose:

- produce the short profile view the agent should read first

A typical ranking snapshot should include:

- top positive topics
- top negative topics
- top entities
- preferred sources
- recent shifts
- active constraints
- a short summary sentence

#### `pin profile drift detect`

```bash
pin profile drift detect --id default --since 14d --json
```

Purpose:

- detect meaningful short-term interest changes
- help the system react to new user curiosity rather than only long-term history

## Rule-Based Rollup Design

`pin profile signal rollup` must be rule-based. This is intentional.

Reasons:

- it needs determinism
- it runs frequently
- it forms the stable feature layer below model-based reasoning
- it must be auditable and easy to tune

### Signal Weighting

Recommended base weights:

- `explicit_like`: `+1.0`
- `explicit_dislike`: `-1.2`
- `shared`: `+0.9`
- `followed_up`: `+0.8`
- `saved`: `+0.7`
- `clicked`: `+0.5`
- `opened`: `+0.3`
- `skipped`: `-0.2`
- `dismissed`: `-0.5`
- `hide_similar`: `-0.9`

Recommended source multipliers:

- `explicit`: `1.0`
- `implicit`: `0.7`
- `agent`: `0.4`

### Time Decay

Each weighted signal should decay over time.

Suggested defaults:

- short-term half-life: `7` days
- long-term half-life: `30` days

Suggested final score mix:

- `0.7 * long_term_score + 0.3 * short_term_score`

### World Item Expansion

Signals against `target_type = world_item` should expand to that item's:

- topics
- entities
- domain
- source/provider

This lets item-specific behavior become generalized user interests.

### Saturation And Normalization

Raw accumulated scores should be normalized with a bounded function such as `tanh` so repeated activity does not create uncontrolled extremes.

### Suppression Rules

Negative feedback must do more than lower scores.

If repeated strong negative signals hit the same topic or entity:

- mark the corresponding interest as `suppressed`
- let `world shortlist` treat suppressed interests as exclusion filters or strong penalties

### Rollup Output

Rollup writes to `profile_interests` with:

- `score`
- `confidence`
- `evidence_count`
- `last_signal_at`
- `status`

## Context Management Rules

Context control is a product requirement, not an optimization detail.

The CLI should enforce these defaults:

- `world get` does not return full `body` or raw payload by default
- `world context` defaults to `compact`
- `world shortlist` defaults to a small limit
- `profile get` returns stable identity only, not all memories and all signals
- `profile snapshot build` is the default profile read for agents
- `profile memory compact` is a first-class maintenance command
- old world data can be compacted while keeping event-level summaries and links

The intended agent read path is:

1. `pin profile snapshot build --view ranking`
2. `pin world shortlist --profile-id <id>`
3. `pin world context --ids <selected_ids> --view compact`

The intended agent write path is:

1. `pin world enrich` when structure is missing
2. `pin profile signal add` after user reaction
3. `pin profile signal rollup`
4. `pin profile snapshot build`

## Testing Strategy

Tests should cover:

- canonical world item ingestion and normalization
- duplicate clustering and relationship linking
- compact vs full world context responses
- signal ingestion validation
- deterministic rollup with fixed timestamps
- suppression after repeated negative signals
- snapshot generation from mixed interests and constraints
- compaction reducing profile/world payload size without losing key structure

Important negative tests:

- invalid JSON arguments return validation envelopes instead of throwing
- `--dry-run` on write commands does not mutate state
- rollup on empty windows is a no-op success

## MVP Scope

Build first:

### `world`

- `ingest`
- `enrich`
- `cluster`
- `shortlist`
- `context`

### `profile`

- `signal add`
- `signal rollup`
- `interests list`
- `memory add`
- `memory compact`
- `snapshot build`

This is the minimum set that enables:

- richer source normalization
- deterministic learning
- compact agent inputs
- iterative recommendation improvement

## Open Questions Resolved

- Should `pin-cli` integrate AI directly: no
- Should rollup be rule-based: yes
- Should finance live inside world: yes, as source-typed items rather than a separate incompatible structure
- Should agent reads default to raw full state: no

## Recommendation

Implement the MVP command set above and treat `profile snapshot build` plus `world context` as the primary agent interfaces. The CLI should optimize for compressed, structured, reusable state, not for one-shot convenience commands.
