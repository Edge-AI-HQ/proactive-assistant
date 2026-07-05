"""Shared generator-task enqueue.

One place for the `pai_scheduled_tasks` payload schema + task-id format used
by BOTH generation entry points:

  * home button  → POST /api/generate         (kind=generator.manual)
  * chat trigger → POST /api/agent/generate   (kind=generator.chat)

The scheduler dispatcher's `_run_generator` reads these exact payload keys,
so keeping them in a single helper prevents the two routes from drifting.
Callers own what differs: virtual-key provisioning, dedup / concurrency
gating, the auth dep (user vs agent), and the HTTP response envelope.
"""

from __future__ import annotations

import uuid

from ...domains.user_model.settings import SettingsRepository
from ...platform.db.repositories.scheduled_tasks import enqueue_once


async def enqueue_generator_task(
    conn,
    *,
    user_id: int,
    kind: str,
    cards_to_generate: int,
    output_language: str | None,
    trigger: str,
    focus: str | None = None,
) -> str:
    """Resolve output_language (fall back to the user's setting when None),
    mint a stable `gen.<uuid>` task id, and enqueue a once-shot generator
    task. Returns the task id (which equals the run id downstream).

    `focus` is only written when set — the dispatcher treats its absence
    as a normal signal-driven batch.
    """
    if output_language is None:
        settings = await SettingsRepository(user_id, conn).get_settings()
        output_language = settings.generation_language
    task_id = f"gen.{uuid.uuid4().hex[:12]}"
    payload: dict[str, object] = {
        "cards_to_generate": cards_to_generate,
        "output_language": output_language,
        "trigger": trigger,
    }
    if focus:
        payload["focus"] = focus
    await enqueue_once(
        conn,
        user_id=user_id,
        task_id=task_id,
        kind=kind,
        payload=payload,
        max_attempts=1,
    )
    return task_id
