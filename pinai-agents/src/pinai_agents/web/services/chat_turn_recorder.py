"""Accumulate an assistant turn's `parts` from the SSE byte stream.

As web pipes chat's SSE response to the client, it also feeds each chunk
here. On stream end this yields the assistant turn in the SAME parts shape
chat/routes/history.py:_build_history emits — so web can persist it to
pai_chat_messages without re-reading the agent's checkpoint. This is the
inverse of chat/streaming.py:emit/langgraph_to_sse.

Event order is preserved (reasoning→text→tool-call interleave) so history
replay matches what the user saw live: contiguous reasoning/text deltas
coalesce into one part; a new part opens whenever the kind switches or a
tool call appears. SSE events that don't shape the visible turn
(chat:thinking / chat:done / chat:error) are ignored here.
"""

from __future__ import annotations

import json
from typing import Any

from ...shared.sse_envelope import (
    EV_CHAT_DELTA,
    EV_CHAT_GROUP_TITLE,
    EV_CHAT_REASONING_DELTA,
    EV_CHAT_TOOL_RESULT,
    EV_CHAT_TOOL_START,
)

_META_LIMIT = 300


class ChatTurnRecorder:
    """Stream-fed accumulator. `feed()` per SSE chunk, `parts()` at the end."""

    def __init__(self) -> None:
        self._buf = b""
        self._parts: list[dict[str, Any]] = []
        # toolCallId → the tool-call part, so chat:tool:result can fill status.
        self._tool_index: dict[str, dict[str, Any]] = {}

    def feed(self, chunk: bytes) -> None:
        """Consume one raw SSE chunk. Buffers partial lines across chunks."""
        self._buf += chunk
        while b"\n" in self._buf:
            raw, self._buf = self._buf.split(b"\n", 1)
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            try:
                payload = json.loads(line[len(b"data:") :].strip())
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(payload, dict):
                self.consume_event(payload)

    def consume_event(self, payload: dict[str, Any]) -> None:
        """Accumulate one already-parsed SSE event dict.

        `feed()` calls this after parsing raw bytes (main chat, which pipes the
        worker's byte stream). proactive_loop iterates already-decoded events
        (it json.loads each SSE line to relay to the bus) and feeds them here
        directly, so the same coalescing logic backs both history sources.
        """
        etype = payload.get("type")
        data = payload.get("data") or {}
        if etype == EV_CHAT_DELTA:
            self._append_text("text", data.get("delta", ""))
        elif etype == EV_CHAT_REASONING_DELTA:
            self._append_text("reasoning", data.get("delta", ""))
        elif etype == EV_CHAT_TOOL_START:
            tool_call_id = data.get("toolCallId")
            if not tool_call_id:
                return
            part: dict[str, Any] = {
                "type": "tool-call",
                "toolCallId": tool_call_id,
                "toolName": data.get("name") or "tool",
                "status": "running",
                "argsPreview": data.get("argsPreview", ""),
            }
            if data.get("args") is not None:
                part["args"] = data["args"]
            # Subagent attribution — history replay must nest the part under
            # the same TaskCard the live stream did.
            parent_task_id = data.get("parentTaskId")
            if isinstance(parent_task_id, str) and parent_task_id:
                part["parentTaskId"] = parent_task_id
                agent_name = data.get("agentName")
                if isinstance(agent_name, str) and agent_name:
                    part["agentName"] = agent_name
            self._parts.append(part)
            self._tool_index[tool_call_id] = part
        elif etype == EV_CHAT_TOOL_RESULT:
            tool_call_id = data.get("toolCallId")
            existing = self._tool_index.get(tool_call_id) if isinstance(tool_call_id, str) else None
            if existing is None:
                return
            existing["status"] = "error" if data.get("isError") else "ok"
            meta = data.get("meta")
            if isinstance(meta, str) and meta:
                existing["meta"] = meta[:_META_LIMIT]
            links = data.get("links")
            if isinstance(links, list) and links:
                existing["links"] = links
        elif etype == EV_CHAT_GROUP_TITLE:
            # Async annotation — backfilled onto the group's anchor tool-call
            # part instead of appended (appending would split a text part
            # that's still coalescing).
            anchor = data.get("anchorToolCallId")
            existing = self._tool_index.get(anchor) if isinstance(anchor, str) else None
            title = data.get("title")
            if existing is not None and isinstance(title, str) and title:
                existing["groupTitle"] = title

    def _append_text(self, kind: str, delta: str) -> None:
        if not delta:
            return
        # Coalesce into the trailing part when it's the same kind; else open
        # a new part (this is what preserves reasoning/text/tool ordering).
        if self._parts and self._parts[-1].get("type") == kind:
            self._parts[-1]["text"] += delta
        else:
            self._parts.append({"type": kind, "text": delta})

    def parts(self) -> list[dict[str, Any]]:
        """The accumulated assistant-turn parts (HistoryMessage.parts shape)."""
        return self._parts

    def is_empty(self) -> bool:
        """True when no visible content streamed (don't persist an empty turn)."""
        return not self._parts
