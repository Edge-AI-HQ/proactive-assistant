"""evolve agent — the sleep-time consolidation pass (Code Mode).

One agent, two triggers (the old evolve / dream / crystallize, merged; design §八):
  * on_event   — after a connector ingest sweep: curate that connector's fresh
                 events + distil what they reveal about the user.
  * daily      — a 24h whole-life sweep: curate the uncurated queue, roll up /
                 forget, refresh the standing portrait.

(Single-session "chat_burst" distillation is gone — it was two-sided dead: the
hot path already distils explicit user input mid-conversation, and cross-session
inference needs the daily whole-life view, not one session. design §八 crystallize-
deleted.)

Two jobs in every run, both over the unified memory layers:
  1. CURATE the L1 event stream — work the uncurated queue (curated_at IS NULL);
     mark each processed via client.events.curate(id). There is no status /
     importance decision: importance is computed objectively at retrieval (§5.5),
     noise is ordered down by that score, not flagged.
  2. DISTIL the L2 portrait — from the events (positive AND negative: what the
     user did, and what they rejected / what failed) update the durable
     portrait via client.user_strings.edit (USER / GOALS), gating on OBJECTIVE
     signals (§8.1), and FORGET stale unreferenced entries.

This is the single-direction L1→L2 distillation (anti-drift): events are the
event truth, the portrait is the compressed standing view derived from them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any

from ..harness.factory import build_agent
from ..harness.llm import make_chat_model
from ..tools.code_mode.sandbox import (
    ONESHOT_AGENT_RUN_TIMEOUT_SEC,
    create_oneshot_sandbox,
    delete_sandbox_now,
)
from ..tools.usage_report import report_compute_usage
from .prompts import CODE_MODE_GUIDANCE, GROUNDING_POLICY, SANDBOX_PREAMBLE, lang_clause

logger = logging.getLogger(__name__)

# Trigger kinds (design §八: two triggers). The prompt's <trigger> block and the
# user message are specialized per kind, the two jobs are shared.
TRIGGER_ON_EVENT = "on_event"
TRIGGER_DAILY = "daily"
_VALID_TRIGGERS = (TRIGGER_ON_EVENT, TRIGGER_DAILY)


_EVOLVE_SYSTEM_PROMPT = f"""You are the PIN AI **evolve** agent — the sleep-time
consolidation pass that turns the raw event stream into durable understanding.

<job>
Two jobs every run, both reading the L1 event stream:

1. CURATE the uncurated queue. New events land uncurated (curated_at NULL); your
   job is to PROCESS them, not to grade them:
     * `client.events.search(status="pending", limit=...)` reads the uncurated
       queue (filter by event_type / since for the triggered scope).
     * For each event you've considered — distilled into the portrait if it
       qualified (§8.1 gating below), or judged not durable — call
       `client.events.curate(id=...)` to mark it processed (stamps curated_at, so
       it leaves the queue; idempotent).
   There is NO status or importance to set. Importance is computed objectively at
   retrieval (reference_count × recency × event_type weight, §5.5) — noise just
   ranks low on its own, you don't flag it. A genuine duplicate / correction is
   handled by supersede (system/projector), not by curate.

2. DISTIL the durable portrait (L2). From the events — POSITIVE and NEGATIVE —
   refine the standing portrait via `client.user_strings.edit(slot=..., operations=[...])`:
     * USER   — durable facts + preferences (role, employer, location, working
       style, dietary, hard constraints) AND standing lessons learned from
       negative signals: dismissed cards, ignored suggestions, failed actions
       ("morning brief flops on Wednesdays"; "don't surface crypto — repeatedly
       dismissed"). Descriptive sentences with evidence, not tag-words.
     * GOALS  — long-term goals (90+ day trajectory) from REPEATED, consistent
       evidence (≥3 events over a sustained window). One isolated event never.
   Operations: [{{"op":"add","text":"..."}}], replace/remove with a `target`
   substring. over_budget → you get every entry back; consolidate into fewer
   and resend as ONE batch.

(Rolling the ambient firehose into episode events is NOT your job — the separate
rollup_semantic agent runs first on the daily sweep and writes those episodes into
L1; you then curate + distil them like any other event.)
</job>

{SANDBOX_PREAMBLE}

{CODE_MODE_GUIDANCE}

{GROUNDING_POLICY}

<hard_rules>
- Gather first, in parallel (asyncio.gather): the uncurated events
  (`client.events.search(status="pending", ...)`) AND the current portrait
  (`client.user_strings.get_all()`). Diff against the portrait before editing —
  never blindly overwrite.
- FORMATION gate — what earns a place in the portrait (§8.1, OBJECTIVE signals,
  no LLM scoring). Err on the side of NOT writing. Promote a fact only when:
    * it's referenced / reinforced repeatedly (recurring events, high
      reference_count), OR
    * the user explicitly stated it (then always keep), OR
    * it's a durable pattern (≥3 consistent events over a sustained window).
  Rate VAGUE / OBVIOUS / one-off low — skip. "User stressed today" = transient,
  skip; "User switched jobs to X" = persistent — write, and capture the
  TRANSITION (what it changed FROM). The portrait is persisted indefinitely:
  never "today" / "recently" — use an absolute date.
- FORGETTING (the anti-rot half): a portrait entry long un-referenced AND with no
  fresh supporting events → EVICT (merge or downgrade, do NOT hard-delete — learn
  MemGPT). PROTECT: anything the user explicitly stated + high-reference facts are
  never forgotten. Simple rule: stale + unreferenced + unprotected → evict.
- Dedupe / contradict: semantically equivalent to an existing entry → skip;
  contradicts one → replace it (new supersedes old), never silently keep both.
- Distil negative signals too. A dismissal / ignored suggestion / failed action
  is evidence — turn it into a standing USER lesson, and for a hard standing
  preference also `client.events.append(event_type="preference",
  source="agent_action", ...)` so it's a first-class signal the next generation
  pass must obey.
- The portrait is derived, single-direction: events → portrait. Never invent
  portrait facts the events don't support. Empty is honest.
- Print a compact JSON summary at the end (events curated count + portrait slots
  touched + entries evicted).
</hard_rules>"""


# Per-trigger <trigger> context appended to the system prompt.
_TRIGGER_CONTEXT: dict[str, str] = {
    TRIGGER_ON_EVENT: (
        "Fires after one or more connectors (Gmail / GCal / Slack / …) finished "
        "ingest sweeps (same-window triggers coalesce into one run per user). "
        "The fresh rows are already projected into pending events. Scope: curate "
        "the new events from the named connectors + distil what they reveal. "
        "Read long-tail source detail via client.raw.list(toolkit, entity) when "
        "an event's payload isn't enough."
    ),
    TRIGGER_DAILY: (
        "A daily whole-life sweep. Scope: the full uncurated queue across all "
        "sources (including the episode events rollup_semantic just rolled from the "
        "ambient firehose — curate them like any other event). Beyond curate + "
        "distil, this is where you FORGET (evict stale, unreferenced portrait "
        "entries — protect user-stated + high-reference). Refresh the standing "
        "portrait from the last day's signal."
    ),
}


def _evolve_system_prompt(trigger_kind: str, output_language: str) -> str:
    trigger = _TRIGGER_CONTEXT.get(trigger_kind, _TRIGGER_CONTEXT[TRIGGER_DAILY])
    return (
        f"{_EVOLVE_SYSTEM_PROMPT}\n\n"
        f"<trigger>\n{trigger}\n</trigger>\n\n"
        "<output_language>\n"
        f"{lang_clause(output_language)} — event titles/bodies and portrait text "
        "are user-visible. Keys, slugs, and JSON field names stay in English.\n"
        "</output_language>"
    )


def _user_message(
    trigger_kind: str,
    *,
    user_id: int,
    run_id: str,
    connector: str | None,
    raw_sources: Any | None,
) -> str:
    base = f"Run evolve (trigger={trigger_kind}) for user_id={user_id} run_id={run_id}. "
    if trigger_kind == TRIGGER_ON_EVENT:
        return (
            base + f"Connector ingest just finished for: {connector}. Curate the "
            "fresh uncurated events from them and distil the portrait per the job + "
            f"hard_rules.\n\n{_raw_sources_hint(connector or 'unknown', raw_sources)}"
        )
    return (
        base + "Daily sweep: work the uncurated queue, forget stale unreferenced "
        "portrait entries, and refresh the portrait per the job + hard_rules."
    )


async def run_evolve(
    *,
    trigger_kind: str = TRIGGER_DAILY,
    virtual_key: str,
    user_id: int,
    run_id: str,
    connector: str | None = None,
    run_jwt: str | None = None,
    raw_sources: Any | None = None,
    model: str | None = None,
    output_language: str = "en",
) -> dict[str, Any]:
    """Run the consolidation pass for one trigger. run_jwt is forwarded into the
    one-shot sandbox so SDK calls back to /api/agent/* are authenticated."""
    if trigger_kind not in _VALID_TRIGGERS:
        trigger_kind = TRIGGER_DAILY
    scope = connector or trigger_kind
    _t0 = time.monotonic()
    backend, raw = await create_oneshot_sandbox(run_jwt=run_jwt, scope_label=f"evolve:{scope}")
    try:
        model_name = model or os.environ.get("CONNECTOR_EVOLVE_MODEL")
        agent = build_agent(
            model=make_chat_model(
                virtual_key=virtual_key,
                model=model_name,
                enable_thinking=False,
            ),
            system_prompt=_evolve_system_prompt(trigger_kind, output_language),
            backend=backend,
        )
        result: dict[str, Any] = {"messages": []}
        try:
            result = await asyncio.wait_for(
                agent.ainvoke(
                    {
                        "messages": [
                            {
                                "role": "user",
                                "content": _user_message(
                                    trigger_kind,
                                    user_id=user_id,
                                    run_id=run_id,
                                    connector=connector,
                                    raw_sources=raw_sources,
                                ),
                            }
                        ],
                    }
                ),
                timeout=ONESHOT_AGENT_RUN_TIMEOUT_SEC,
            )
        except TimeoutError:
            logger.warning(
                "evolve run timed out after %ds user=%d trigger=%s scope=%s — sandbox force-deleted",
                ONESHOT_AGENT_RUN_TIMEOUT_SEC,
                user_id,
                trigger_kind,
                scope,
            )
    finally:
        await delete_sandbox_now(raw)
        report_compute_usage(
            provider="daytona",
            duration_seconds=time.monotonic() - _t0,
            source=f"daytona:evolve:{trigger_kind}:{scope}",
            run_jwt=run_jwt,
            metadata={"scope": "oneshot", "trigger": trigger_kind, "target": scope},
        )
    msgs = result.get("messages", [])
    final = msgs[-1] if msgs else None
    return {
        "summary": _final_message_text(final)[:2000],
        "trigger": trigger_kind,
        "scope": scope,
    }


def _final_message_text(final: Any) -> str:
    """Text of the agent's final message — handles LangChain content blocks
    (list of {type:text}), plain string, and dict shapes."""
    if final is None:
        return ""
    content = final.get("content") if isinstance(final, dict) else getattr(final, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return str(content or "")


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
