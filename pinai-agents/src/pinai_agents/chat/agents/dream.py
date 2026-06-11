"""auto.dreaming agent — Code Mode.

Triggered by scheduler every day 06:00 (per-user, user's timezone).
Job: scan the last 24h of personal_signals + raw connector data + chat
sessions, distill into new memories / profile updates / skill triggers.

Output: side-effects (writes to memory / profile / skills via SDK) plus
a brief reasoning summary returned as JSON for the audit log.
"""

from __future__ import annotations

import logging
from typing import Any

from ..harness.factory import build_agent
from ..harness.llm import make_chat_model
from ..tools.code_mode.sandbox import create_oneshot_sandbox, delete_sandbox_now
from .prompts import CODE_MODE_GUIDANCE, GROUNDING_POLICY, SANDBOX_PREAMBLE

logger = logging.getLogger(__name__)

_DREAM_LOOKBACK_HOURS = 24
_DREAM_MAX_ROWS = 10_000
_DREAM_RAW_SOURCES = (
    "gmail/messages",
    "gcal/events",
    "gdrive/files",
    "googledocs/documents",
    "googlesheets/spreadsheets",
    "slack/messages",
    "github/issues",
    "calendly/events",
    "stripe/invoices",
    "youtube/subscriptions",
    "linkedin/profile",
    "device/apps",
    "device/contacts",
    "device/health",
)


# Order: identity → trigger → goal → SANDBOX → CODE_MODE → GROUNDING →
# hard rules → output contract.
_DREAM_SYSTEM_PROMPT = f"""You are the Pin AI **auto.dreaming** agent.

<trigger>
Scheduled run, nightly (per-user timezone). Sweep the user's last
{_DREAM_LOOKBACK_HOURS}h of activity.
</trigger>

<goal>
Produce:
  * new long-term memories (what's now known about user persona / preferences)
  * updates to existing memories (supersede when stale)
  * profile updates (display_name / locale / timezone / facts / preferences)
</goal>

{SANDBOX_PREAMBLE}

{CODE_MODE_GUIDANCE}

{GROUNDING_POLICY}

<hard_rules>
- Daily input is deterministic. Your first gather MUST include:
  `client.signals.recent(status="all", hours={_DREAM_LOOKBACK_HOURS}, limit={_DREAM_MAX_ROWS}, include_payload=True)`.
  Treat personal signals as the primary source of truth for the day,
  including all summaries and transcript payload text in the window.
- Also gather raw rows from the same {_DREAM_LOOKBACK_HOURS}h window as
  supplementary evidence. Use `client.raw.list(toolkit, entity,
  hours={_DREAM_LOOKBACK_HOURS}, limit={_DREAM_MAX_ROWS})` for supported
  sources when available: {", ".join(_DREAM_RAW_SOURCES)}.
- Do not rely on SDK default limits for this daily run. Do not stop at
  the first 20-50 rows. If the result is large, chunk by kind/source and
  account for every chunk before deciding what to write.
- Do not truncate the daily signal set before analysis. Printed debug
  output may be summarized, but your reasoning must cover the full fetched
  set and the final JSON must include totalSignals and totalRawRows.
- Do not write precise home/work location, address-like facts, or weak
  location inferences to memory/profile unless they are repeated, useful,
  and non-sensitive at city/district granularity.
- Don't write speculative memory ("user might like X"). Only write
  what the data evidences directly.
- When superseding, prefer 1 supersede over 2 archives.
- Keep your printed summary under 2KB — context window is finite.
</hard_rules>

<output_contract>
Final assistant message must be JSON only:

  {{"memoriesWritten": int,
    "memoriesSuperseded": int,
    "profileFieldsUpdated": [str, ...],
    "totalSignals": int,
    "totalRawRows": int,
    "summary": str}}
</output_contract>
"""


def _message_content_text(content: Any) -> str:
    """Normalize LangChain text-block content into plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
                elif isinstance(block.get("content"), str):
                    parts.append(block["content"])
        return "\n".join(parts)
    return str(content or "")


def _final_message_text(final: Any) -> str:
    content = (
        getattr(final, "content", None)
        if final is not None and not isinstance(final, dict)
        else (final or {}).get("content")
    )
    return _message_content_text(content)


async def run_dream(
    *,
    virtual_key: str,
    user_id: int,
    run_id: str,
    run_jwt: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    backend, raw = await create_oneshot_sandbox(
        run_jwt=run_jwt,
        scope_label="dream",
    )
    try:
        agent = build_agent(
            model=make_chat_model(virtual_key=virtual_key, model=model, thinking_budget=8000),
            system_prompt=_DREAM_SYSTEM_PROMPT,
            backend=backend,
        )
        result: dict[str, Any] = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            f"Run nightly dream for user_id={user_id} run_id={run_id}. "
                            "Before analysis, gather the full daily context with "
                            f"client.signals.recent(status='all', hours={_DREAM_LOOKBACK_HOURS}, "
                            f"limit={_DREAM_MAX_ROWS}, include_payload=True) and same-window raw.list calls "
                            f"with limit={_DREAM_MAX_ROWS}. Use signals as the primary "
                            "source and raw as supporting evidence. Distill into "
                            "memory/profile updates only when the evidence is direct."
                        ),
                    }
                ],
            }
        )
    finally:
        await delete_sandbox_now(raw)
    msgs = result.get("messages", [])
    final = msgs[-1] if msgs else None
    final_text = _final_message_text(final)
    return {"summary": final_text[:2000]}
