"""auto.dreaming agent — Code Mode.

Triggered by scheduler every day 06:00 (per-user, user's timezone).
Job: scan the last 24h of personal_signals + raw connector data + chat
sessions, distill into new memories / profile updates / skill triggers.

Output: side-effects (writes to memory / profile / skills via SDK) plus
a brief reasoning summary returned as JSON for the audit log.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx
from deepagents import create_deep_agent

from ..runtime.llm import make_chat_model
from ..tools.sandbox import create_oneshot_sandbox, delete_sandbox_now
from .prompts import CODE_MODE_GUIDANCE, GROUNDING_POLICY, SANDBOX_PREAMBLE

logger = logging.getLogger(__name__)

# Used to record the run in pai_evolution_runs via web's
# /api/agent/evolution/* endpoints. The frontend dream-history panel
# (/api/dreaming/runs) reads from that table; without this lifecycle
# wrapper the panel sees zero rows even when dream produced memory /
# profile writes (the agent itself has no SDK helper for evolution_runs).
_EVOL_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=10.0)


def _web_url() -> str:
    return os.environ.get("WEB_INTERNAL_URL", "http://pinai-web:8000")


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
    trigger_kind: str = "daily_dream",
) -> dict[str, Any]:
    started_monotonic = time.monotonic()
    evol_id = await _create_evolution_run(
        run_jwt=run_jwt, run_id=run_id, trigger_kind=trigger_kind,
    )
    try:
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
        summary_text = str(final_text)[:2000]
        if evol_id and run_jwt:
            await _complete_evolution_run(
                run_jwt=run_jwt, evol_id=evol_id,
                duration_ms=int((time.monotonic() - started_monotonic) * 1000),
                summary=summary_text,
            )
        return {"summary": summary_text}
    except Exception as e:
        if evol_id and run_jwt:
            await _fail_evolution_run(
                run_jwt=run_jwt, evol_id=evol_id, error_message=str(e)[:500],
            )
        raise


# ── Evolution-run lifecycle helpers ────────────────────────────────────
# Best-effort: any failure here is swallowed + logged. The dream's
# primary side effects (memory.add / profile.upsert from inside the
# sandbox) don't depend on these endpoints, so a transient web blip
# shouldn't fail the run — it just means the dream-history panel will
# miss the row, which is recoverable by re-running.


async def _create_evolution_run(
    *, run_jwt: str | None, run_id: str, trigger_kind: str,
) -> str | None:
    if not run_jwt:
        return None
    try:
        async with httpx.AsyncClient(
            base_url=_web_url(), timeout=_EVOL_HTTP_TIMEOUT,
        ) as cli:
            resp = await cli.post(
                "/api/agent/evolution/create",
                json={
                    "triggerKind": trigger_kind,
                    "contextSummary": f"Dream run {run_id}",
                    "promptExcerpt": _DREAM_SYSTEM_PROMPT[:500],
                },
                headers={"Authorization": f"Bearer {run_jwt}"},
            )
        resp.raise_for_status()
        return resp.json().get("id")
    except Exception:
        logger.exception(
            "evolution.create failed run_id=%s trigger=%s — dream history will miss this run",
            run_id, trigger_kind,
        )
        return None


async def _complete_evolution_run(
    *, run_jwt: str, evol_id: str, duration_ms: int, summary: str,
) -> None:
    try:
        async with httpx.AsyncClient(
            base_url=_web_url(), timeout=_EVOL_HTTP_TIMEOUT,
        ) as cli:
            resp = await cli.post(
                f"/api/agent/evolution/{evol_id}/complete",
                json={
                    "durationMs": duration_ms,
                    "details": {"summary": summary},
                },
                headers={"Authorization": f"Bearer {run_jwt}"},
            )
        resp.raise_for_status()
    except Exception:
        logger.exception(
            "evolution.complete failed evol_id=%s — row stays in 'running' until reconciler",
            evol_id,
        )


async def _fail_evolution_run(
    *, run_jwt: str, evol_id: str, error_message: str,
) -> None:
    try:
        async with httpx.AsyncClient(
            base_url=_web_url(), timeout=_EVOL_HTTP_TIMEOUT,
        ) as cli:
            resp = await cli.post(
                f"/api/agent/evolution/{evol_id}/fail",
                json={"errorMessage": error_message},
                headers={"Authorization": f"Bearer {run_jwt}"},
            )
        resp.raise_for_status()
    except Exception:
        logger.exception(
            "evolution.fail failed evol_id=%s — row stays in 'running' until reconciler",
            evol_id,
        )
