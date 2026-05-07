"""Memory native @tool wrappers — chat agent uses these.

Thin shells around web /api/agent/memory/*. Each tool description is
LLM-facing — keep it action-oriented (verb + when to use), not
schema-documentation.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class MemoryListInput(BaseModel):
    min_quality: float = Field(
        default=0.7, ge=0, le=1,
        description="Quality threshold (0-1). Default 0.7 returns reliable memories; lower it to see more.",
    )
    subject: str | None = Field(
        default=None, max_length=200,
        description="Filter by subject tag (e.g. 'work', 'family'). Omit for all subjects.",
    )
    limit: int = Field(
        default=20, ge=1, le=50,
        description="Max results. Keep small to save context.",
    )


@tool("memory_list", args_schema=MemoryListInput)
async def memory_list(min_quality: float, subject: str | None, limit: int):
    """List user's high-quality long-term memories. Use when you need
    persona / preference / past-decision context."""
    payload = await http_client.get(
        "/api/agent/memory/list",
        minQuality=min_quality, subject=subject, limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    # Truncate text to keep LLM context lean.
    return [
        {
            "id": m["id"],
            "text": (m.get("text") or "")[:200],
            "subject": m.get("subject"),
            "quality": m.get("quality"),
        }
        for m in items
    ]


class MemorySearchInput(BaseModel):
    query: str = Field(
        min_length=1, max_length=500,
        description="Natural-language query — semantic search over memories.",
    )
    min_quality: float | None = Field(
        default=None, ge=0, le=1,
        description="Optional quality floor. Default None returns all qualities.",
    )
    limit: int = Field(default=10, ge=1, le=50)


@tool("memory_search", args_schema=MemorySearchInput)
async def memory_search(query: str, min_quality: float | None, limit: int):
    """Semantic search over user memories (pgvector). Use when the user
    asks about a topic / fact and `memory_list` filters aren't precise
    enough."""
    payload = await http_client.get(
        "/api/agent/memory/search",
        q=query, minQuality=min_quality, limit=limit,
    )
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": m["id"],
            "text": (m.get("text") or "")[:200],
            "subject": m.get("subject"),
            "quality": m.get("quality"),
        }
        for m in items
    ]


class MemoryGetInput(BaseModel):
    id: str = Field(min_length=1)


@tool("memory_get", args_schema=MemoryGetInput)
async def memory_get(id: str):
    """Fetch a single memory by id (when memory_list previews aren't enough)."""
    return await http_client.get(f"/api/agent/memory/get/{id}")


class MemoryAddInput(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    source: str = Field(default="chat")
    subject: str | None = None
    quality: float = Field(default=0.6, ge=0, le=1)


@tool("memory_add", args_schema=MemoryAddInput)
async def memory_add(text: str, source: str, subject: str | None, quality: float):
    """Persist a new long-term memory the user just shared. Only call when
    the user explicitly stated a fact about themselves (preference, goal,
    constraint). Don't store transient context."""
    return await http_client.post(
        "/api/agent/memory/add",
        {"text": text, "source": source, "subject": subject, "quality": quality},
    )
