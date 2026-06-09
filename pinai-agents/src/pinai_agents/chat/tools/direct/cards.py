"""Cards native @tool — read recently-generated Intent Cards + trigger
a fresh generation from chat."""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class CardsRecentInput(BaseModel):
    limit: int = Field(default=20, ge=1, le=100)


@tool("cards_recent", args_schema=CardsRecentInput)
async def cards_recent(limit: int):
    """Recently-generated Intent Cards across the user's pipeline runs.
    Use to avoid pushing duplicates and to surface what the user recently
    saw, dismissed, or acted on."""
    payload = await http_client.get("/api/agent/cards/recent", limit=limit)
    if isinstance(payload, dict) and payload.get("error"):
        return payload
    items = payload.get("items", []) if isinstance(payload, dict) else []
    return [
        {
            "id": c.get("id"),
            "runId": c.get("runId"),
            "goalBasket": c.get("goalBasket"),
            "title": c.get("title"),
            "whyNow": (c.get("whyNow") or "")[:200],
            "createdAt": c.get("createdAt") or c.get("runStartedAt"),
        }
        for c in items
    ]


class GenerateCardInput(BaseModel):
    focus: str | None = Field(
        default=None,
        max_length=400,
        description=(
            "What the new card should be about — the topic / thing the "
            "user cares about right now (e.g. 'my Q3 OKR review', 'A-share "
            "market this week', 'follow-ups from yesterday's emails'). "
            "Leave empty to generate a normal batch from the user's "
            "current signals (same as the home Generate button)."
        ),
    )
    count: int = Field(
        default=3,
        ge=1,
        le=8,
        description=(
            "How many cards to generate. Use a small number (1-3) for a "
            "focused topic; raise toward 8 only for an open 'refresh my "
            "cards' style request."
        ),
    )


@tool("generate_card", args_schema=GenerateCardInput)
async def generate_card(focus: str | None, count: int):
    """Generate new Intent Card(s) for the user — the same cards that
    appear on their Now page. Call this when the user asks you to make /
    create / generate a card, or wants cards about a specific topic they
    care about.

    Generation runs in the background and takes ~1 minute. The result tells
    you the queue status — act on it, don't assume success:
      * status="queued": tell the user the card is being generated and will
        show up on their Now page shortly. Do NOT claim it is already there.
      * status="busy": a few generations are already running; tell the user
        to wait for those to land before asking for more.
      * an "error" key: queuing failed; tell the user it couldn't be started
        and offer to try again. Do NOT claim a card is coming.

    Pass `focus` when the user named a topic so the card centers on it; omit
    it for a general refresh."""
    body: dict[str, object] = {"cards_to_generate": count}
    if focus:
        body["focus"] = focus
    return await http_client.post("/api/agent/generate", body)
