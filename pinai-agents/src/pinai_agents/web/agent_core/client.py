"""ChatRunClient — web → chat execution call + SSE→Frame relay.

The worker-side counterpart to web/routes/ui/chat.py's request handler:
signs a per-run EdDSA JWT, POSTs the chat worker, parses its SSE byte stream
into Frame dicts, and yields them so the worker can fan out (FrameBus) +
record (ChatTurnRecorder). chat never sees DB/credentials — the LiteLLM
virtual_key + Browserbase context ride in the JWT claims (trust boundary,
plan §十一).

Reuses the existing /agent/chat SSE endpoint as the executor. `run()` sends the
merged mailbox batch as separate role=user messages (CORE-0 verified the LLM
accepts consecutive user turns); `resume()` re-enters a HITL-paused run via
Command(resume=) (plan §五). Cancel: cancelling the async generator (worker
task.cancel()) tears down the httpx stream → chat sees a client disconnect →
aborts the LLM + releases the sandbox (plan §十一 "cancel 真停").
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..auth.agent_jwt import sign_agent_run_jwt
from .framebus import Frame

logger = logging.getLogger(__name__)

# A chat turn's read timeout must exceed one agent turn; mirrors chat_proxy.
_READ_TIMEOUT_SECONDS = 600.0


def _chat_internal_url() -> str:
    """Same default as chat_proxy; CHAT_INTERNAL_URL splits web/chat later."""
    return os.environ.get("CHAT_INTERNAL_URL", "http://pinai-chat:8001")


class ChatRunError(Exception):
    """The chat worker returned a non-2xx, or was unreachable."""


class ChatRunClient:
    """Drives one agent execution on the chat worker and relays its frames."""

    async def run(
        self,
        *,
        kind: str,
        session_id: str,
        user_id: int,
        messages: list[str],
        virtual_key: str | None,
        browserbase_context_id: str | None = None,
        card_context: dict[str, Any] | None = None,
        run_id: str | None = None,
        timezone: str | None = None,
        client_hints: dict[str, Any] | None = None,
        bypass_permissions: bool = False,
    ) -> AsyncIterator[Frame]:
        """Execute on chat and yield parsed SSE Frames.

        `messages` is the merged mailbox batch — each pending user message is
        forwarded as its OWN role=user message (NOT concatenated; CORE-0
        verified the LLM accepts consecutive user turns), so the agent sees
        distinct turns. Forwards to the existing /agent/chat SSE endpoint,
        which fans `messages` into HumanMessages. `kind` is accepted now (the
        worker call site is already kind-aware) but only starts routing once a
        dedicated /agent/run lands; today every kind uses the chat endpoint.
        """
        token, _ = sign_agent_run_jwt(
            user_id=user_id,
            run_id=run_id,
            virtual_key=virtual_key,
            browserbase_context_id=browserbase_context_id,
        )
        body: dict[str, Any] = {
            "session_key": session_id,
            "messages": messages,
            "card_context": card_context,
            # User's IANA timezone (profile truth, web-resolved — chat has no
            # DB): chat injects a <current_datetime> anchor per send turn.
            "timezone": timezone,
            # Display device hints (panel CSS size + mobile/tablet/desktop)
            # from the FE send; chat's browser_tool sizes the BB session +
            # picks the stealth UA for the device actually showing it.
            "client_hints": client_hints,
            # Per-run "bypass permissions": forwarded so chat builds the agent
            # without the HITL approval middleware. Default False keeps the gate.
            "bypass_permissions": bypass_permissions,
        }
        async for frame in self._stream_frames(
            body=body, token=token, run_id=run_id, session_id=session_id
        ):
            yield frame

    async def resume(
        self,
        *,
        kind: str,
        session_id: str,
        user_id: int,
        decisions: list[dict[str, Any]],
        virtual_key: str | None,
        browserbase_context_id: str | None = None,
        run_id: str | None = None,
    ) -> AsyncIterator[Frame]:
        """Resume a HITL-paused run: chat re-enters the same thread via
        Command(resume={"decisions": ...}) instead of new messages (verified
        2026-06-05). `decisions` aligns with the interrupt's action_requests —
        [{type: approve|reject|edit|respond, ...}]. `kind` is accepted for
        symmetry with run() but unused while every kind uses /agent/chat."""
        token, _ = sign_agent_run_jwt(
            user_id=user_id,
            run_id=run_id,
            virtual_key=virtual_key,
            browserbase_context_id=browserbase_context_id,
        )
        body: dict[str, Any] = {
            "session_key": session_id,
            "resume": {"decisions": decisions},
        }
        async for frame in self._stream_frames(
            body=body, token=token, run_id=run_id, session_id=session_id
        ):
            yield frame

    async def _stream_frames(
        self,
        *,
        body: dict[str, Any],
        token: str,
        run_id: str | None,
        session_id: str,
    ) -> AsyncIterator[Frame]:
        """POST /agent/chat and yield parsed SSE frames — shared by run() +
        resume(). Raises ChatRunError on non-2xx / unreachable."""
        url = f"{_chat_internal_url()}/agent/chat"
        timeout = httpx.Timeout(connect=5.0, read=_READ_TIMEOUT_SECONDS, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream(
                    "POST",
                    url,
                    json=body,
                    headers={"Authorization": f"Bearer {token}", "X-Run-Id": run_id or ""},
                ) as resp:
                    if resp.status_code >= 400:
                        payload = await resp.aread()
                        msg = (
                            f"chat worker {resp.status_code}: "
                            f"{payload[:200].decode(errors='replace')}"
                        )
                        logger.warning("ChatRunClient %s session=%s", msg, session_id)
                        raise ChatRunError(msg)
                    async for frame in _parse_sse(resp.aiter_bytes()):
                        yield frame
            except httpx.RequestError as e:
                msg = f"chat worker unreachable: {type(e).__name__}: {e}"
                logger.exception("ChatRunClient unreachable session=%s", session_id)
                raise ChatRunError(msg) from e


async def _parse_sse(chunks: AsyncIterator[bytes]) -> AsyncIterator[Frame]:
    """Split an SSE byte stream into parsed `data:` event dicts.

    Mirrors ChatTurnRecorder.feed's line framing (buffer partial lines across
    chunks; one JSON object per `data:` line) — kept separate because the
    recorder accumulates history parts while this yields live frames.
    """
    buf = b""
    async for chunk in chunks:
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            try:
                payload = json.loads(line[len(b"data:") :].strip())
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(payload, dict):
                yield payload
