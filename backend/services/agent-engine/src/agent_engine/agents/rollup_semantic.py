"""rollup_semantic agent — the semantic half of the rollup stage (doc §4.2).

Split out of evolve (rollup R4): this is L0 → L1 PROJECTION (collapse the ambient
firehose into episode events), NOT L1 → L2 distillation (that's evolve). The two
were conflated in evolve's prompt (an old job 3); separating them keeps evolve
single-purpose (curate + distil) and gives the firehose roll-up its own focused
prompt +独立 testability.

The projector deliberately skips `device` `utterance` / `transcript_window` raw
(high-volume, low-value per row — they'd drown the real signal in L1). This agent
rolls a run of them into one episode event each. Daily, LLM, async — mirrors
run_evolve's one-shot sandbox shape.
"""

from __future__ import annotations

import asyncio
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


_ROLLUP_SEMANTIC_SYSTEM_PROMPT = f"""You are the PIN AI **rollup_semantic** agent —
you collapse the ambient firehose into episode events (doc §4.2, the semantic
rollup stage). The projector deliberately does NOT project `transcript_window`
raw one-by-one (a few-second evidence window — high-volume, low-value per row;
one-by-one they'd drown the real signal in L1). Your one job is to roll each
continuous run of them into a single episode event. (`utterance` /
session_summary is a finished per-conversation transcript — the projector emits
those 1→1 in real time, so they are NOT your job; don't read or roll them.)

<job>
1. Read the firehose (last 24h):
     `client.raw.list("device", "transcript_window", hours=24)`
2. Segment by continuous topic + time — a cluster of consecutive windows about
   ONE thing = one episode. Don't over-segment (a whole conversation = one
   episode, NOT one per window); don't merge unrelated topics across a clear time
   gap or topic shift.
3. Write each episode:
     `client.events.append(event_type="utterance", source="device",
        title=<one-line gist>, body=<concise summary of the episode>,
        occurred_at=<cluster start>, end_at=<cluster end>,
        dedupe_key=f"episode:device:{{cluster_start_iso}}")`
   The time-window dedupe_key makes re-runs idempotent (re-rolling the same window
   no-ops). No firehose rows → no episodes; empty is fine, exit cleanly.
</job>

{SANDBOX_PREAMBLE}

{CODE_MODE_GUIDANCE}

{GROUNDING_POLICY}

<hard_rules>
- This is rollup, NOT distillation: you produce L1 episode EVENTS only. Never
  touch the L2 portrait (no client.user_strings.edit) — that's evolve's job, it
  runs after you and will distil the episodes you write.
- 35 sentences → 1 episode is the spirit: the episode is a concise SUMMARY; the
  per-sentence detail stays in L0 raw (the event's time window points back to it).
- Segment on topic shift + time gap. When unsure whether two clusters are one
  episode or two, prefer fewer/larger episodes — over-segmentation re-creates the
  firehose problem.
- Print a compact JSON summary at the end (episodes written count + window).
</hard_rules>"""


def _system_prompt(output_language: str) -> str:
    return (
        f"{_ROLLUP_SEMANTIC_SYSTEM_PROMPT}\n\n"
        "<output_language>\n"
        f"{lang_clause(output_language)} — episode titles/bodies are user-visible. "
        "Keys, slugs, and JSON field names stay in English.\n"
        "</output_language>"
    )


async def run_rollup_semantic(
    *,
    virtual_key: str,
    user_id: int,
    run_id: str,
    run_jwt: str | None = None,
    model: str | None = None,
    output_language: str = "en",
) -> dict[str, Any]:
    """Roll the last 24h ambient firehose into episode events. One-shot sandbox,
    same shape as run_evolve. run_jwt is forwarded so SDK calls back to
    /api/agent/* are authenticated."""
    _t0 = time.monotonic()
    backend, raw = await create_oneshot_sandbox(run_jwt=run_jwt, scope_label="rollup_semantic")
    try:
        model_name = model or os.environ.get("CONNECTOR_EVOLVE_MODEL")
        agent = build_agent(
            model=make_chat_model(
                virtual_key=virtual_key,
                model=model_name,
                enable_thinking=False,
            ),
            system_prompt=_system_prompt(output_language),
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
                                "content": (
                                    f"Roll up the last 24h ambient firehose for "
                                    f"user_id={user_id} run_id={run_id}. Read "
                                    "transcript_window raw, segment into episodes, append each "
                                    "per the job + hard_rules."
                                ),
                            }
                        ],
                    }
                ),
                timeout=ONESHOT_AGENT_RUN_TIMEOUT_SEC,
            )
        except TimeoutError:
            logger.warning(
                "rollup_semantic timed out after %ds user=%d — sandbox force-deleted",
                ONESHOT_AGENT_RUN_TIMEOUT_SEC,
                user_id,
            )
    finally:
        await delete_sandbox_now(raw)
        report_compute_usage(
            provider="daytona",
            duration_seconds=time.monotonic() - _t0,
            source="daytona:rollup_semantic",
            run_jwt=run_jwt,
            metadata={"scope": "oneshot", "trigger": "daily"},
        )
    msgs = result.get("messages", [])
    final = msgs[-1] if msgs else None
    return {"summary": _final_message_text(final)[:2000], "scope": "rollup_semantic"}


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
