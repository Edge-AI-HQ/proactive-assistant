"""Unified SSE envelope shared across chat / browser / task domains.

Wire format on the SSE bus:

    data: {"type":"chat:delta","ts":1730000000000,"traceId":"run_…","data":{"delta":"hi"}}

Why an envelope vs. flat events:
  * `ts` lets the client order events deterministically when multiple
    streams interleave (chat:delta + browser:url:changed in the same
    session). The frontend uses this to drive timeline ordering.
  * `traceId` carries the run-id / session-key so multi-stream correlation
    works without the client tracking it per-event-type. Helpful for
    log-side debugging too.
  * `data` is the per-event-type payload — keeps the top-level shape
    stable so a single SSE parser dispatches to per-namespace reducers
    without union-type gymnastics.

Type name conventions:
  * `<namespace>:<verb>`         — chat:delta, chat:done
  * `<namespace>:<noun>:<verb>`  — chat:tool:start, browser:control:granted

Namespaces in use:
  * chat:*    — LangGraph chat stream (deltas / reasoning / tools / errors).
  * browser:* — Browserbase browser tool lifecycle (Step 4).
  * task:*    — long-running task progress (scheduler / dream / evolve).

Each domain's constants live near the emitters (e.g. chat/sse_events.py)
so we don't grow one giant union here. The envelope is the only shared
contract.

Pydantic validation is on the SCHEMA, not on each emit (every emit
allocating a model instance is too hot). Helpers in `chat/streaming.py`
construct the dict directly, then we round-trip-validate in tests to
guarantee the shape stays correct.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# Type field is namespaced verbs joined by colons. Lower-snake or simple
# alpha tokens only — no spaces, no uppercase. Same shape on the
# frontend's reducer key.
_TYPE_PATTERN = re.compile(r"^[a-z]+(:[a-z][a-z_]*)+$")


class SSEEvent(BaseModel):
    """Wire schema for one SSE event.

    Validate-on-construct only when you NEED to reject malformed input
    (rare — most callers go through the helpers below which produce
    well-formed envelopes by construction). For the hot emit path,
    `emit()` builds a dict directly and skips Pydantic.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    type: str = Field(min_length=1, max_length=120)
    ts: int = Field(description="ms since epoch")
    trace_id: str | None = Field(default=None, alias="traceId", max_length=200)
    data: dict[str, Any] = Field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        """Serialize with camelCase keys (frontend convention)."""
        out: dict[str, Any] = {"type": self.type, "ts": self.ts}
        if self.trace_id is not None:
            out["traceId"] = self.trace_id
        out["data"] = self.data
        return out

    @classmethod
    def validate_type(cls, value: str) -> str:
        if not _TYPE_PATTERN.match(value):
            msg = f"invalid SSE type {value!r} — expected ns:verb[:verb]"
            raise ValueError(msg)
        return value


def emit(
    type: str,
    data: dict[str, Any] | None = None,
    *,
    trace_id: str | None = None,
    ts_ms: int | None = None,
) -> bytes:
    """Build one SSE-encoded event.

    Hot path — does NOT instantiate Pydantic. Use validate_event() in
    tests or in non-hot code paths where you want a defensive parse.
    """
    payload: dict[str, Any] = {
        "type": type,
        "ts": ts_ms if ts_ms is not None else int(time.time() * 1000),
    }
    if trace_id is not None:
        payload["traceId"] = trace_id
    payload["data"] = data or {}
    encoded = json.dumps(payload, ensure_ascii=False)
    return f"data: {encoded}\n\n".encode()


def validate_event(payload: dict[str, Any]) -> SSEEvent:
    """Defensive parse — validates type pattern + envelope shape.
    Raises pydantic ValidationError on malformed input."""
    SSEEvent.validate_type(payload["type"])
    return SSEEvent.model_validate(payload)


# ── well-known event types ──
# Living inventory. Unit tests assert these all match the type pattern,
# preventing accidental "chat:Foo" / "chat-delta" drift on rename.

# chat:* (LangGraph chat agent stream)
EV_CHAT_THINKING = "chat:thinking"
EV_CHAT_DELTA = "chat:delta"
EV_CHAT_REASONING_DELTA = "chat:reasoning:delta"
EV_CHAT_TOOL_START = "chat:tool:start"
EV_CHAT_TOOL_RESULT = "chat:tool:result"
# Async annotation: an LLM-generated title for a closed work group
# (contiguous reasoning/tool run between text segments). Carries
# anchorToolCallId (the group's first tool call — the part the title is
# backfilled onto) + title. Best-effort: a group whose title never
# arrives keeps the frontend's deterministic fallback label.
EV_CHAT_GROUP_TITLE = "chat:group:title"
# HITL: a side-effect tool paused on HumanInTheLoopMiddleware's interrupt().
# Carries interruptId (resume anchor) + the tool call + allowedDecisions.
EV_CHAT_REQUIRES_ACTION = "chat:requires_action"
EV_CHAT_ERROR = "chat:error"
EV_CHAT_DONE = "chat:done"

# browser:* (Browserbase browser tool — Step 4)
EV_BROWSER_OPENED = "browser:opened"
EV_BROWSER_CLOSED = "browser:closed"
EV_BROWSER_NAVIGATED = "browser:navigated"
EV_BROWSER_CONTROL_GRANTED = "browser:control:granted"
EV_BROWSER_CONTROL_TAKEOVER = "browser:control:takeover"
EV_BROWSER_ERROR = "browser:error"

# task:* (long-running tasks — scheduler / dream / evolve)
EV_TASK_PROGRESS = "task:progress"
EV_TASK_DONE = "task:done"
EV_TASK_ERROR = "task:error"
