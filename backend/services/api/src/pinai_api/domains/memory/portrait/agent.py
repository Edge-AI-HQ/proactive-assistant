"""Agent-facing L2 profile API — read the portrait + memory_edit (write).

/api/agent/user-strings — EdDSA JWT (current_agent_run), under user_scoped_tx.
GET / returns the five-slot portrait; POST /edit applies add/replace/remove ops
to ANY of the five portrait slots (IDENTITY/SOUL/TOOLS/USER/GOALS) via the
hermes MemoryStore algorithm — all five are agent-maintained (the user only
reads them on the Mirror page). The AGENTS safety constant is not a DB slot and
is not editable here; an unknown slot fails with `bad_op`.

Atomic double-write (design doc 6.1): a SUCCESSFUL edit also appends a
portrait-change event into L1 (`source=agent_action`, `event_type=
agent_decision`) in the SAME transaction — L2 stays freely mutable while its
change history lands in the immutable event stream ("when did the portrait
change, from what") without relying on the agent to make a second tool call.
A failed edit (version_conflict / over_budget / threat / bad_op) writes no
event. This is the designed ⑤→③ dependency (import-linter contract allows it).
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pinai_db.rls import user_scoped_tx
from pydantic import BaseModel, Field

from ....platform.auth.deps import AgentRun, current_agent_run, get_pool
from ..events import AppendEventInput, EventsRepository, gen_event_id
from .repository import EditOp, UserStringsRepository

router = APIRouter(prefix="/api/agent/user-strings", tags=["agent-user-strings"])

# Truncation caps for the change event: ops land in `structured` for
# programmatic forgetting evidence (8.1③) and a short human summary lands in
# body for FTS — neither needs the full entry text to be duplicated into L1.
_OP_TEXT_CAP = 300
_OP_TARGET_CAP = 120


def _change_event(
    *, slot: str, ops: list[EditOp], version: int, evidence_event_ids: list[str] | None
) -> AppendEventInput:
    """The portrait-change event for one successful edit. dedupe_key is
    (slot, new version) — version increments on every committed edit, so the
    key is naturally unique and a replayed request no-ops."""
    kinds: dict[str, int] = {}
    for o in ops:
        kinds[o.op] = kinds.get(o.op, 0) + 1
    summary = ", ".join(f"{k}×{n}" for k, n in kinds.items())
    lines = []
    for o in ops:
        if o.op == "add":
            lines.append(f"add: {o.text[:_OP_TEXT_CAP]}")
        elif o.op == "replace":
            lines.append(f"replace {o.target[:_OP_TARGET_CAP]} → {o.text[:_OP_TEXT_CAP]}")
        else:
            lines.append(f"{o.op}: {o.target[:_OP_TARGET_CAP]}")
    structured: dict[str, object] = {
        "slot": slot,
        "version": version,
        "ops": [
            {"op": o.op, "target": o.target[:_OP_TARGET_CAP], "text": o.text[:_OP_TEXT_CAP]}
            for o in ops
        ],
    }
    if evidence_event_ids:
        structured["evidence_event_ids"] = evidence_event_ids
    return AppendEventInput(
        id=gen_event_id(),
        source="agent_action",
        event_type="agent_decision",
        occurred_at=datetime.now(UTC),
        dedupe_key=f"user_strings:{slot}:v{version}",
        title=f"Portrait {slot} updated ({summary})",
        body="\n".join(lines),
        structured=structured,
        # An agent-authored change record needs no evolve judgement.
        curated=True,
    )


@router.get("/")
async def get_portrait(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """The five-slot portrait (markdown content per slot)."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = UserStringsRepository(run.user_id, conn)
        portrait = await repo.get_all()
    return {"slots": portrait}


class EditOpRequest(BaseModel):
    op: str = Field(description="add | replace | remove")
    text: str = ""
    target: str = ""


class EditRequest(BaseModel):
    slot: str
    operations: list[EditOpRequest]
    expected_version: int | None = Field(default=None, alias="expectedVersion")
    # Optional anchors: event ids that support this portrait change (the agent
    # cites its evidence). Carried into the change event's structured.
    evidence_event_ids: list[str] | None = Field(
        default=None, alias="evidenceEventIds", max_length=20
    )


@router.post("/edit")
async def edit_portrait(
    body: EditRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Apply add/replace/remove ops to any of the five portrait slots
    (IDENTITY/SOUL/TOOLS/USER/GOALS). Returns the new version on success;
    `over_budget` hands back every entry so the agent consolidates and retries
    as one batch; an unknown slot returns `bad_op`. The slot is validated in the
    repository against the five-slot set.

    On success the portrait-change event is appended in the SAME transaction
    (atomic double-write, module docstring) — the edit and its L1 change record
    commit or roll back together."""
    ops = [EditOp(op=o.op, text=o.text, target=o.target) for o in body.operations]
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = UserStringsRepository(run.user_id, conn)
        result = await repo.edit(body.slot, operations=ops, expected_version=body.expected_version)
        if result.ok:
            await EventsRepository(run.user_id, conn).append(
                _change_event(
                    slot=result.slot,
                    ops=ops,
                    version=result.version,
                    evidence_event_ids=body.evidence_event_ids,
                )
            )
    return {
        "ok": result.ok,
        "slot": result.slot,
        "version": result.version,
        "reason": result.reason,
        **({"entries": result.entries} if result.entries else {}),
    }
