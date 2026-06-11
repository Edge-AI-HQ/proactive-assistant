"""connector.evolve agent — Code Mode.

Triggered after a Composio connector finishes an ingest sweep. Reads
the just-ingested raw rows + existing memory / signals / profile / goals
state, then produces (in order of how often each fires):

  * new pai_personal_signals (open, ready for next generation) — most
    output volume
  * memory writes — free-form facts the data surfaces
  * profile upserts — structured persona attributes (display_name /
    locale / timezone / summary / facts / preferences / constraints)
    when connector evidence refines the *current* profile
  * goal upserts — long-term named goals inferred from repeated,
    consistent connector evidence (rare; one isolated row never)

Smaller scope than `dream` — focuses on a single connector's payload
window.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from ..harness.factory import build_agent
from ..harness.llm import make_chat_model
from ..tools.code_mode.sandbox import create_oneshot_sandbox, delete_sandbox_now
from .prompts import CODE_MODE_GUIDANCE, GROUNDING_POLICY, SANDBOX_PREAMBLE

logger = logging.getLogger(__name__)
_DEFAULT_EVOLVE_MODEL = "claude-sonnet-4-6"


# Order: identity → trigger → goal → SANDBOX → CODE_MODE → GROUNDING →
# hard rules → output contract.
_EVOLVE_SYSTEM_PROMPT = f"""You are the Pin AI **connector.evolve** agent.

<trigger>
Fires after one connector (Gmail / GCal / Slack / etc.) finishes an
ingest sweep. The newly-ingested raw rows are available via
`client.raw.<toolkit>.<entity>`. Long-tail connectors use generic
storage: rows carry optional `title`/`snippet` projections plus the
complete source item in `payload` (JSONB) — treat `payload` as the
source of truth and read whatever fields it actually has.
</trigger>

<goal>
Turn raw rows into four kinds of writes — most runs touch only the
first one or two. The user's persona model is the union of these
layers; each has a different durability and editing rule.

  * personal_signals — high-salience, fresh items the next generation
    pass should consider. Most output volume lives here.
  * memory — free-form one-liner facts the connector data surfaces
    ("subscribes to HuggingFace Daily Papers", "uses Robinhood for
    DCA"). Most rows do NOT become memories — favor evidence + recency.
  * profile — STRUCTURED persona attributes: `display_name`, `locale`,
    `timezone`, `summary`, and the three JSONB buckets `facts` /
    `preferences` / `constraints`. Update only when connector evidence
    contradicts or refines the *current* profile (which you must fetch
    first — see hard_rules).
  * goals — long-term named goals (career / health / family / wealth,
    typically 90+ day trajectory). Inferred from REPEATED, consistent
    connector evidence (weeks of marathon-training events; a sustained
    pattern of job-hunt emails). One isolated row does not make a goal.
</goal>

{SANDBOX_PREAMBLE}

{CODE_MODE_GUIDANCE}

{GROUNDING_POLICY}

<hard_rules>
- Fetch existing state in your initial gather: `client.profile.get()`
  returns `{{"profile": ..., "goals": [...]}}` in one call. Diff against
  it before deciding to upsert — never blindly overwrite. Memories +
  open signals also belong in the same gather (parallel asyncio).
- Most rows do NOT become signals. Be selective — favor recency +
  salience.
- Use the connector's natural keys for `dedupe_key`
  (e.g. `gmail.<thread_id>`, `gcal.<event_id>`).
- profile vs memory boundary: structured persona attribute (role,
  employer, locale, timezone, working hours, dietary, hard
  constraints) → `client.profile.upsert(...)` into the matching field
  / bucket. Free-form one-liner fact → `client.memory.add(...)`. When
  in doubt, prefer memory — profile is the higher-confidence layer.
- profile JSONB buckets (`facts` / `preferences` / `constraints`) are
  *replaced wholesale* by upsert. To add a single new key, read the
  current bucket from the gather, merge in your new key, and pass the
  merged dict — otherwise you'll wipe siblings.
- Profile bucket VALUES are descriptive sentences, not tag-words.
  Each value answers *what + evidence + when/frequency*. Good:
  `facts.employer = "Founder + engineer at PIN-AI; active on the
  PIN-AI-ASSISTANT refactor/deepagents branch since 2026-03."`
  Bad: `facts.employer = "PIN-AI"` — a future generation pass can't
  do anything with that. Same rule applies to preferences and
  constraints.
- goals: only `client.profile.upsert_goal(...)` when you see REPEATED
  evidence across multiple raw rows (≥3 events / messages over a
  sustained window). Use a stable slug for `key` so the same goal
  updates in place across evolve runs. Don't speculate from a single
  email.
- Don't write speculative memory or profile. If evidence is thin, say
  so plainly — empty is honest.
- Print a compact JSON summary at the end (counts per layer + ids).
</hard_rules>
"""


async def run_evolve(
    *,
    virtual_key: str,
    user_id: int,
    run_id: str,
    connector: str,
    run_jwt: str | None = None,
    raw_sources: Any | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    # run_jwt is forwarded into create_oneshot_sandbox so it can mint a
    # phantom token for the sandbox; without it sandbox-side SDK calls
    # would 401 against /api/agent/* (no auth header).
    backend, raw = await create_oneshot_sandbox(
        run_jwt=run_jwt,
        scope_label=f"evolve:{connector}",
    )
    try:
        model_name = model or os.environ.get("CONNECTOR_EVOLVE_MODEL") or _DEFAULT_EVOLVE_MODEL
        raw_sources_hint = _raw_sources_hint(connector, raw_sources)
        agent = build_agent(
            model=make_chat_model(
                virtual_key=virtual_key,
                model=model_name,
                enable_thinking=False,
            ),
            system_prompt=_EVOLVE_SYSTEM_PROMPT,
            backend=backend,
        )
        result: dict[str, Any] = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            f"Run evolve for user_id={user_id} run_id={run_id} "
                            f"connector={connector}. Distill the latest raw window "
                            f"into signals, memory, profile, and goal updates per "
                            f"the goal block + hard_rules.\n\n{raw_sources_hint}"
                        ),
                    }
                ],
            }
        )
    finally:
        await delete_sandbox_now(raw)
    msgs = result.get("messages", [])
    final = msgs[-1] if msgs else None
    final_text = (
        getattr(final, "content", None)
        if final is not None and not isinstance(final, dict)
        else (final or {}).get("content")
    ) or ""
    return {"summary": str(final_text)[:2000], "connector": connector}


def _raw_sources_hint(connector: str, raw_sources: Any) -> str:
    if isinstance(raw_sources, list):
        cleaned: list[dict[str, str]] = []
        for item in raw_sources:
            if not isinstance(item, dict):
                continue
            toolkit = item.get("toolkit")
            entity = item.get("entity")
            if isinstance(toolkit, str) and isinstance(entity, str) and toolkit and entity:
                cleaned.append({"toolkit": toolkit, "entity": entity})
        if cleaned:
            return (
                "Raw sources for this evolve run are:\n"
                f"{json.dumps(cleaned, ensure_ascii=False)}\n"
                "Read them with client.raw.list(toolkit, entity, limit=100). "
                "Do not use dynamic client.raw.<toolkit> attributes."
            )
    return (
        "Use client.raw.list(connector, entity, limit=100) for long-tail or "
        f"custom connectors. If connector {connector!r} is a custom MCP connector, "
        "the entity is usually 'items'. Do not use dynamic client.raw.<toolkit> attributes."
    )
