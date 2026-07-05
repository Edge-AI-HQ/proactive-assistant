"""Memory retrieval eval — the pytest entry that drives the harness against the
real events_search over the pgvector test DB (design §十 P0).

Each fixture gets a fresh user (user_ids provisions + CASCADE-cleans per test), so
parametrized fixtures don't bleed events into each other. We seed the fixture's
events via EventsRepository, run the real structured retrieval, hand the ranked
ids to the harness, and assert every query clears its thresholds.

Semantic (`q`) queries need an embedding backend and are skipped here — the
skeleton ships with structured + reference fixtures that run with no external key.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_db.rls import user_scoped_tx

from tests.eval.memory.harness import evaluate, load_fixtures

_FIXTURES = load_fixtures()


def _parse_dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if isinstance(value, str) else None


@pytest.mark.parametrize("fixture", _FIXTURES, ids=[f.name for f in _FIXTURES])
@pytest.mark.asyncio
async def test_fixture_meets_thresholds(fixture, pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EventsRepository(user_a, conn)

        # ── seed the fixture's ground-truth events ──
        for ev in fixture.seed_events:
            await repo.append(
                AppendEventInput(
                    id=ev["id"],
                    source=ev.get("source", "composio"),
                    event_type=ev["event_type"],
                    occurred_at=_parse_dt(ev["occurred_at"]),
                    title=ev.get("title"),
                    body=ev.get("body"),
                    structured=ev.get("structured"),
                    dedupe_key=ev.get("dedupe_key", ev["id"]),
                    curated=ev.get("curated", False),
                )
            )
            # reference_count is normally bumped by retrieval; seed it directly so
            # the objective-ranking fixtures can pin "high reference ranks first".
            if ev.get("reference_count"):
                await conn.execute(
                    "UPDATE pai_events SET reference_count = %s WHERE user_id = %s AND id = %s",
                    (ev["reference_count"], user_a, ev["id"]),
                )

        # ── run each query through the real retriever + score ──
        for query in fixture.queries:
            params = dict(query.params)
            run_id = "eval_run" if params.pop("with_run_id", False) else None
            if "q" in params:
                pytest.skip(
                    f"{fixture.name}/{query.name}: semantic query needs an embedding backend"
                )
            rows = await repo.search_structured(
                event_type=params.get("event_type"),
                since=_parse_dt(params.get("since")),
                until=_parse_dt(params.get("until")),
                status=params.get("status", "active"),
                limit=params.get("limit", 30),
                run_id=run_id,
            )
            ranked = [r.id for r in rows]
            result = evaluate(ranked, query)
            assert not result.failures, (
                f"[{fixture.name}/{query.name}] thresholds missed: {result.failures} "
                f"(ranked={ranked}, metrics={ {k: round(v, 3) for k, v in result.metrics.items()} })"
            )
