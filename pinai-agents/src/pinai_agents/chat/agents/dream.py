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

from deepagents import create_deep_agent

from ..runtime.llm import make_chat_model
from ..tools.sandbox import create_oneshot_sandbox, delete_sandbox_now
from .prompts import CODE_MODE_GUIDANCE, GROUNDING_POLICY, SANDBOX_PREAMBLE

logger = logging.getLogger(__name__)


# Order: identity → trigger → goal → SANDBOX → CODE_MODE → GROUNDING →
# hard rules → output contract.
_DREAM_SYSTEM_PROMPT = f"""You are the Pin AI **auto.dreaming** agent.

<trigger>
Scheduled run, nightly (per-user timezone). Sweep the user's last
24-48h of activity.
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
    "summary": str}}
</output_contract>
"""


async def run_dream(
    *,
    virtual_key: str,
    user_id: int,
    run_id: str,
    run_jwt: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    backend, raw = await create_oneshot_sandbox(
        run_jwt=run_jwt, scope_label="dream",
    )
    try:
        agent = create_deep_agent(
            model=make_chat_model(virtual_key=virtual_key, model=model, thinking_budget=8000),
            system_prompt=_DREAM_SYSTEM_PROMPT,
            backend=backend,
        )
        result: dict[str, Any] = await agent.ainvoke({
            "messages": [{
                "role": "user",
                "content": (
                    f"Run nightly dream for user_id={user_id} run_id={run_id}. "
                    "Pull recent activity, distill into memory/profile updates."
                ),
            }],
        })
    finally:
        await delete_sandbox_now(raw)
    msgs = result.get("messages", [])
    final = msgs[-1] if msgs else None
    final_text = (
        getattr(final, "content", None)
        if final is not None and not isinstance(final, dict)
        else (final or {}).get("content")
    ) or ""
    return {"summary": str(final_text)[:2000]}
