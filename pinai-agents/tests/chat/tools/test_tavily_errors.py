"""Tavily failures must surface as status="error" ToolMessages.

langchain_tavily swallows API exceptions into a normal `{"error": e}` return
(only empty results raise) — prod saw 30x "Error 432" quota failures render
as green checkmarks while the agent retried blind. Our subclasses re-raise
ToolException so BaseTool's handle_tool_error path (enabled by default on
these tools) emits a real error ToolMessage.
"""

from __future__ import annotations

import os

# langchain_tavily validates TAVILY_API_KEY at import time (module-level
# singletons in chat/tools/direct/tavily.py), so the env must be set BEFORE
# any import below — hence the E402 suppressions on the imports that follow
# (same pattern as tests/chat/routes/test_chat_local_sandbox.py).
os.environ.setdefault("TAVILY_API_KEY", "unit-test-key")

from typing import Any  # noqa: E402

import pytest  # noqa: E402
from langchain_core.messages import ToolMessage  # noqa: E402
from langchain_core.tools import ToolException  # noqa: E402
from langchain_tavily import TavilyExtract, TavilySearch  # noqa: E402

from pinai_agents.chat.tools.direct.tavily import tavily_extract, tavily_search  # noqa: E402


def _tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool_call", "name": name, "args": args, "id": "call-1"}


@pytest.mark.asyncio
async def test_search_error_payload_becomes_error_tool_message(monkeypatch) -> None:
    async def fake_arun(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"error": Exception("Error 432: ")}

    monkeypatch.setattr(TavilySearch, "_arun", fake_arun)

    msg = await tavily_search.ainvoke(_tool_call("tavily_search", {"query": "lindy.ai"}))

    assert isinstance(msg, ToolMessage)
    assert msg.status == "error"
    assert "tavily request failed" in str(msg.content)
    assert "432" in str(msg.content)


@pytest.mark.asyncio
async def test_extract_error_payload_becomes_error_tool_message(monkeypatch) -> None:
    async def fake_arun(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"error": Exception("Error 432: ")}

    monkeypatch.setattr(TavilyExtract, "_arun", fake_arun)

    msg = await tavily_extract.ainvoke(
        _tool_call("tavily_extract", {"urls": ["https://example.com"]})
    )

    assert isinstance(msg, ToolMessage)
    assert msg.status == "error"
    assert "tavily request failed" in str(msg.content)


@pytest.mark.asyncio
async def test_search_success_payload_passes_through(monkeypatch) -> None:
    payload = {"results": [{"title": "Lindy AI", "url": "https://lindy.ai"}]}

    async def fake_arun(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return payload

    monkeypatch.setattr(TavilySearch, "_arun", fake_arun)

    msg = await tavily_search.ainvoke(_tool_call("tavily_search", {"query": "lindy.ai"}))

    assert isinstance(msg, ToolMessage)
    assert msg.status != "error"
    assert "lindy.ai" in str(msg.content)


@pytest.mark.asyncio
async def test_library_tool_exception_path_not_regressed(monkeypatch) -> None:
    """langchain_tavily raises ToolException itself on empty results — our
    wrapper must stay transparent to that existing error path."""

    async def fake_arun(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        raise ToolException("No search results found")

    monkeypatch.setattr(TavilySearch, "_arun", fake_arun)

    msg = await tavily_search.ainvoke(_tool_call("tavily_search", {"query": "nothing"}))

    assert isinstance(msg, ToolMessage)
    assert msg.status == "error"
    assert "No search results found" in str(msg.content)
