"""crystallize agent — Code Mode, in-process subrun.

Triggered when a chat session ends (user closes / inactivity timeout
N minutes). Reads the chat thread's recent messages, distills into
memories / skills.

Distinct from auto.dreaming: scope is one chat session, narrower.
"""

from __future__ import annotations

import logging
from typing import Any

from ..harness.factory import build_agent
from ..harness.llm import make_chat_model
from ..tools.code_mode.sandbox import create_oneshot_sandbox, delete_sandbox_now
from .prompts import CODE_MODE_GUIDANCE, GROUNDING_POLICY, SANDBOX_PREAMBLE, lang_clause

logger = logging.getLogger(__name__)


# Order: identity → trigger → goal → SANDBOX → CODE_MODE → GROUNDING →
# hard rules → output contract.
_CRYSTALLIZE_SYSTEM_PROMPT = f"""You are the Pin AI **crystallize** agent.

<trigger>
A chat conversation just ended (user closed, or inactivity timeout).
You're given the session_key for that thread.
</trigger>

<goal>
Distill the thread into:
  * memory entries — what's now known about user persona
  * skill triggers — action patterns the user values
    (e.g. "always cc legal for contract emails")
</goal>

{SANDBOX_PREAMBLE}

{CODE_MODE_GUIDANCE}

{GROUNDING_POLICY}

<hard_rules>
- Don't crystallize transient preferences ("user wants X today").
- Only crystallize patterns evidenced ≥2 times in the thread.
- Dedupe before write — `memory.add` and `skill.add` are idempotent
  but you should still avoid writing near-duplicates of existing rows.
- Print a compact JSON summary at the end (≤ 1KB).
</hard_rules>
"""


def _crystallize_system_prompt(output_language: str) -> str:
    return (
        f"{_CRYSTALLIZE_SYSTEM_PROMPT}\n"
        "<output_language>\n"
        f"{lang_clause(output_language)} — memory bodies, skill descriptions, "
        "and summary strings are user-visible. Keys, slugs, and JSON field "
        "names stay in English.\n"
        "</output_language>"
    )


async def run_crystallize(
    *,
    virtual_key: str,
    user_id: int,
    run_id: str,
    session_key: str,
    model: str | None = None,
    output_language: str = "en",
) -> dict[str, Any]:
    backend, raw = await create_oneshot_sandbox()
    try:
        agent = build_agent(
            model=make_chat_model(virtual_key=virtual_key, model=model, thinking_budget=4000),
            system_prompt=_crystallize_system_prompt(output_language),
            backend=backend,
        )
        result: dict[str, Any] = await agent.ainvoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            f"Crystallize chat session_key={session_key} user_id={user_id} "
                            f"run_id={run_id}. Distill the thread into memory + skills."
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
    return {"summary": str(final_text)[:1500], "sessionKey": session_key}
