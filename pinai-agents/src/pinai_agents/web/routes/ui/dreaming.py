"""/api/dreaming/* — frontend dreaming runs surface.

Dreaming runs live in pai_evolution_runs with trigger_kind='daily_dream'
(or 'manual' when user-triggered). Trigger goes through scheduler which
dispatches to chat worker /agent/run/dream.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.evolution import EvolutionRepository, EvolutionRunRow
from ...db.repositories.scheduled_tasks import ScheduledTasksRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/dreaming", tags=["dreaming"])


def _to_dict(row: EvolutionRunRow) -> dict[str, Any]:
    d = asdict(row)
    for k in ("window_start", "window_end", "started_at", "completed_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    d["trigger"] = row.trigger_kind
    d["summary"] = {"text": row.context_summary or ""}
    return d


def _agent_report(row: EvolutionRunRow) -> dict[str, Any]:
    details = row.details or {}
    report = details.get("agentReport")
    return report if isinstance(report, dict) else {}


def _produced_memory_ids(row: EvolutionRunRow) -> list[str]:
    ids = row.refs_produced.get("pai_memory")
    if not isinstance(ids, list):
        return []
    return [str(v) for v in ids if str(v).strip()]


def _memory_title(memory: dict[str, Any], index: int) -> str:
    subject = memory.get("subject")
    if isinstance(subject, str) and subject.strip():
        label = subject.strip().replace("_", " ").title()
        return f"{label} thread"
    return f"Theme {index + 1}"


def _assistant_voice(text: str) -> str:
    replacements = (
        ("Xing Hu is", "You are"),
        ("Xing is", "You are"),
        ("Xing has", "You have"),
        ("Xing watches", "You watch"),
        ("Xing watched", "You watched"),
        ("Xing engages", "You engage"),
        ("Xing commented", "You commented"),
        ("Xing said", "You said"),
        ("Xing explicitly stated", "You explicitly stated"),
        ("Xing", "you"),
        ("Regularly watches", "You regularly watch"),
    )
    out = text
    for before, after in replacements:
        out = out.replace(before, after)
    return out


def _clip_text(text: str, *, limit: int = 520) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _first_sentence(text: str) -> str:
    clipped = _assistant_voice(_clip_text(text, limit=360))
    stops = [". ", "。", "! ", "? "]
    positions = [clipped.find(stop) for stop in stops if clipped.find(stop) > 0]
    if not positions:
        return clipped
    return clipped[: min(positions) + 1].strip()


def _looks_like_run_log(text: str) -> bool:
    lower = text.lower()
    return (
        ("signals" in lower and "processed" in lower)
        or "raw rows" in lower
        or "memories written" in lower
        or "profile facts refreshed" in lower
    )


def _journal_summary(row: EvolutionRunRow, memories: list[dict[str, Any]]) -> str:
    report = _agent_report(row)
    summary = report.get("summary") or row.context_summary
    if isinstance(summary, str) and summary.strip() and not _looks_like_run_log(summary):
        return _clip_text(summary, limit=900)
    if memories:
        observations = [
            _first_sentence(str(memory.get("text") or ""))
            for memory in memories
            if str(memory.get("text") or "").strip()
        ]
        if observations:
            return "A few patterns stood out from your day. " + " ".join(observations[:3])
    return "I looked back over your day and found a few signals worth carrying forward."


def _profile_change_sentence(row: EvolutionRunRow) -> str | None:
    if not row.profile_updated:
        return None
    keys = [k for k in row.profile_changed_keys if k.strip()]
    if not keys:
        return "I also updated my profile of you, but this run did not record which fields changed."
    readable = ", ".join(k.replace("facts.", "").replace("preferences.", "") for k in keys[:6])
    suffix = "" if len(keys) <= 6 else f", and {len(keys) - 6} more"
    return f"I updated my model of you around {readable}{suffix}."


def _dream_markdown(
    row: EvolutionRunRow,
    memories: list[dict[str, Any]],
) -> str:
    lines = [
        "## Dream Journal",
        (
            "I looked back over your day as your personal assistant. "
            "What matters here is the shape of your attention, the themes "
            "that repeated, and what I should remember for next time."
        ),
        "",
        _journal_summary(row, memories),
    ]

    if memories:
        lines.extend(["", "## What I noticed"])
        for index, memory in enumerate(memories):
            text = _assistant_voice(str(memory.get("text") or "").strip())
            if text:
                lines.append(f"- **{_memory_title(memory, index)}**: {_clip_text(text)}")
    profile_sentence = _profile_change_sentence(row)
    if profile_sentence:
        lines.extend(["", "## What changed in my understanding of you", profile_sentence])
    return "\n".join(lines).strip()


def _source_breakdown(row: EvolutionRunRow) -> list[dict[str, Any]]:
    report = _agent_report(row)
    out: list[dict[str, Any]] = []
    signals = report.get("totalSignals")
    if isinstance(signals, int):
        out.append(
            {
                "sourceId": "personal_signals",
                "status": "ok",
                "itemCount": signals,
                "reason": "24h daily dream signal window",
            }
        )
    raw_rows = report.get("totalRawRows")
    if isinstance(raw_rows, int):
        out.append(
            {
                "sourceId": "raw",
                "status": "ok" if raw_rows > 0 else "skipped",
                "itemCount": raw_rows,
                "reason": "24h supplementary raw-source window",
            }
        )
    return out


@router.get("/runs")
async def list_dreaming_runs(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """List dream/manual runs from pai_evolution_runs.

    Response shape: `{ok, runs}` where each run has the snake_case row
    fields the SPA's AutoDreamingSettings reads directly.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        repo = EvolutionRepository(user.id, conn)
        # Daily dream + manual (user-triggered) runs.
        rows = await repo.list(limit=50)
    return {
        "ok": True,
        "runs": [_to_dict(r) for r in rows if r.trigger_kind in ("daily_dream", "manual")],
    }


@router.get("/runs/{run_id}")
async def get_dream_run(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Single dream run detail.

    SPA's `DreamRunDetailResponse` expects `{ok, run, detail}`. The
    `detail` blob holds the rich tracing payload (rawInputs / dream
    markdown / source breakdown / log) that the EvolutionRunRow itself
    doesn't carry today — return an empty-shaped placeholder so the SPA
    doesn't blow up reading missing keys, and we can fill it in once
    the agent run pipeline persists tracing artifacts.
    """
    memories: list[dict[str, Any]] = []
    async with user_scoped_tx(pool, user.id) as conn:
        repo = EvolutionRepository(user.id, conn)
        row = await repo.get(run_id)
        if row is not None:
            memory_ids = _produced_memory_ids(row)
            if memory_ids:
                cur = await conn.execute(
                    """
                    SELECT id, subject, text, status, created_at
                    FROM pai_memory
                    WHERE user_id = %s AND id = ANY(%s)
                    """,
                    (user.id, memory_ids),
                )
                by_id = {r["id"]: r for r in await cur.fetchall()}
                memories = [by_id[mid] for mid in memory_ids if mid in by_id]
    if row is None:
        raise HTTPException(status_code=404, detail="dream run not found")
    dream_markdown = _dream_markdown(row, memories)
    return {
        "ok": True,
        "run": _to_dict(row),
        "detail": {
            "rawInputs": {},
            "normalizedInputs": {},
            "summary": {"kind": row.trigger_kind, "text": row.context_summary or ""},
            "dreamMarkdownPath": None,
            "dreamMarkdown": dream_markdown,
            "profileDelta": {
                "updated": row.profile_updated,
                "changedKeys": row.profile_changed_keys,
            },
            "goalDelta": {
                "changes": [],
                "note": (
                    "No durable per-run goal diff is recorded yet; "
                    "goal writes do not carry source_run_id."
                ),
            },
            "candidates": [
                {
                    "id": memory["id"],
                    "title": _memory_title(memory, index),
                    "reason": memory["text"],
                    "type": "memory",
                    "status": memory["status"],
                }
                for index, memory in enumerate(memories)
            ],
            "sourceBreakdown": _source_breakdown(row),
            "logPath": None,
            "logText": row.error_message or "",
        },
    }


@router.post("/run", status_code=status.HTTP_202_ACCEPTED)
async def trigger_dream(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Manual trigger via scheduler. Inserts a 'once' task with
    next_run_at=NOW() so the next tick picks it up and dispatches to
    chat worker /agent/run/dream.
    """
    task_id = f"dream-manual-{uuid.uuid4().hex[:8]}"
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ScheduledTasksRepository(user.id, conn)
        await repo.upsert(
            id=task_id,
            kind="auto.dreaming",
            trigger_kind="once",
            next_run_at=datetime.now(UTC) - timedelta(seconds=1),  # immediately due
            payload={"trigger": "manual"},
            name="Manual dream trigger",
        )
    # Frontend AutoDreamingSettings checks `data.ok` and uses `data.runId`
    # for the success notice. We don't materialize a run row until the
    # dispatcher claims this task, so reuse task_id as the runId proxy —
    # callers only use it for display, not for cross-table joins.
    return {
        "ok": True,
        "runId": task_id,
        "taskId": task_id,
        "status": "queued",
        "asOf": datetime.now(UTC).isoformat(),
    }
