"""DeepAgents + Daytona sandbox compatibility spike.

End-to-end check that:
    1. Daytona credentials work (DAYTONA_API_KEY decrypted into env).
    2. Daytona().create() succeeds (cold start measured).
    3. DeepAgents `create_deep_agent` accepts a DaytonaSandbox backend.
    4. The agent's default fs+shell middleware actually routes file/exec
       calls into the Daytona sandbox (not the local pinai-agents process).

Verification trick: agent is told to write a sentinel string into a path
inside the sandbox, then run `cat` on it. The sentinel only exists in the
sandbox FS; if we see it back from execute(), we know fs+shell are wired.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from deepagents import create_deep_agent
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..llm import make_chat_model
from ..sandbox import create_oneshot_sandbox, delete_sandbox_now

logger = logging.getLogger(__name__)
router = APIRouter()

# Random-ish sentinel — pinai-agents process never writes this file locally,
# so observing it via the agent confirms the file landed in the sandbox.
_SENTINEL = "PINAI_SANDBOX_OK_8a3f"
_SENTINEL_PATH = "/tmp/pinai_sandbox_spike.txt"


class SandboxSpikeRequest(BaseModel):
    virtual_key: str = Field(min_length=8)
    model: str | None = None


class SandboxSpikeResponse(BaseModel):
    ok: bool
    sandbox_id: str | None = None
    cold_start_ms: int | None = None
    agent_run_ms: int | None = None
    sentinel_observed: bool = False
    final_message_preview: str | None = None
    error: str | None = None


_AGENT_INSTRUCTIONS = (
    "You are a sandbox-compat test agent. Use the available tools to verify "
    "you can write and read inside the sandbox. Steps in order:\n"
    f"  1. Use write_file to create '{_SENTINEL_PATH}' with content '{_SENTINEL}'.\n"
    f"  2. Use the execute (shell) tool to run `cat {_SENTINEL_PATH}`.\n"
    "  3. Reply with one short line: the exact content the cat command produced. "
    "Do not explain. Do not call additional tools. Stop after step 3."
)


@router.post("/agent/sandbox-spike", response_model=SandboxSpikeResponse)
async def sandbox_spike(req: SandboxSpikeRequest) -> SandboxSpikeResponse:
    """Run a one-shot DeepAgent in a fresh Modal sandbox; verify wiring."""

    raw_sandbox = None
    try:
        t0 = time.perf_counter()
        backend, raw_sandbox = await create_oneshot_sandbox()
        cold_start_ms = int((time.perf_counter() - t0) * 1000)

        agent = create_deep_agent(
            model=make_chat_model(virtual_key=req.virtual_key, model=req.model),
            system_prompt=_AGENT_INSTRUCTIONS,
            backend=backend,
        )

        t1 = time.perf_counter()
        result: dict[str, Any] = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Run the sandbox compat steps."}]}
        )
        agent_run_ms = int((time.perf_counter() - t1) * 1000)

        msgs = result.get("messages", [])
        logger.info(
            "sandbox spike messages count=%d types=%s",
            len(msgs),
            [type(m).__name__ for m in msgs[-6:]],
        )
        # Find the final assistant message text.
        final_text = _final_assistant_text(msgs)
        sentinel_observed = _SENTINEL in (final_text or "")

        return SandboxSpikeResponse(
            ok=sentinel_observed,
            sandbox_id=raw_sandbox.id,
            cold_start_ms=cold_start_ms,
            agent_run_ms=agent_run_ms,
            sentinel_observed=sentinel_observed,
            final_message_preview=(final_text or "")[:240],
        )
    except Exception as e:
        logger.exception("sandbox spike failed")
        # Don't echo virtual_key in error message even if buried in stack.
        msg = f"{type(e).__name__}: {e}"
        raise HTTPException(status_code=500, detail=_redact(msg)) from e
    finally:
        if raw_sandbox is not None:
            await delete_sandbox_now(raw_sandbox)


def _final_assistant_text(messages: list[Any]) -> str | None:
    """Pull the last assistant text content from a LangGraph state messages list.

    Messages can be LangChain BaseMessage subclasses (.type / .content) or
    plain dicts ({"role": ..., "content": ...}). We accept both shapes and
    skip messages whose content is empty (typical when the LLM only emitted
    tool_calls in that turn).
    """
    for msg in reversed(messages):
        if isinstance(msg, dict):
            role = msg.get("role") or msg.get("type")
            content = msg.get("content")
        else:
            role = getattr(msg, "type", None) or getattr(msg, "role", None)
            content = getattr(msg, "content", None)
        if role not in ("ai", "assistant"):
            continue
        text = _content_to_text(content)
        if text:
            return text
    return None


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                t = b.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _redact(s: str) -> str:
    import re
    return re.sub(r"sk-[A-Za-z0-9_-]{6,}", "sk-***", s)
