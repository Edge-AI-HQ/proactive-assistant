"""Preference + language native @tool wrappers — main chat uses these.

Thin shells around web /api/agent/preferences/* and the agent settings
route. `preference_add` is for persistent CONTENT preferences ("show me
more A-share news", "stop pushing work cards"). `set_generation_language`
is for language switches — it flips a deterministic setting, NOT a
preference row, so the next generation actually comes back in the new
language instead of hoping the planner reads a row.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class PreferenceAddInput(BaseModel):
    statement: str = Field(
        min_length=1, max_length=2000,
        description=(
            "The preference in the user's own framing, one sentence "
            "(e.g. 'Wants more A-share market news', 'Does not want "
            "work-related cards on weekends'). Only call when the user "
            "expressed a PERSISTENT preference, not a one-off ask."
        ),
    )
    scope: Literal["topic", "source", "timing", "format", "global"] = Field(
        description=(
            "What the preference is about: 'topic' (subject matter), "
            "'source' (which connector / channel), 'timing' (when), "
            "'format' (how it's presented), 'global' (applies broadly)."
        ),
    )
    polarity: Literal["positive", "negative"] = Field(
        description="'positive' = wants more of this; 'negative' = wants less / none.",
    )
    card_id: str | None = Field(
        default=None,
        description=(
            "Set ONLY when this preference came from feedback on a specific "
            "card the user is looking at — pass that card's id so the "
            "preference records its evidence."
        ),
    )
    durability: Literal["temporary", "persistent"] = Field(
        default="persistent",
        description=(
            "'temporary' for time-boxed generation guidance such as 'today "
            "show me AI news' or 'for the next batch'; 'persistent' for "
            "durable preferences that should keep shaping future cards."
        ),
    )
    expires_at: datetime | None = Field(
        default=None,
        description=(
            "Expiry timestamp for temporary preferences. Use the user's "
            "timezone when known. Leave null for persistent preferences."
        ),
    )


@tool("preference_add", args_schema=PreferenceAddInput)
async def preference_add(
    statement: str,
    scope: Literal["topic", "source", "timing", "format", "global"],
    polarity: Literal["positive", "negative"],
    card_id: str | None,
    durability: Literal["temporary", "persistent"] = "persistent",
    expires_at: datetime | None = None,
):
    """Persist content preference / generation guidance the user just
    stated in chat ("I want to see more X", "stop showing me Y").
    High-weight: the next card generation treats valid active preferences
    as near-hard constraints. Use `durability='temporary'` plus
    `expires_at` for time-boxed asks such as "today push AI news"; do not
    promote those into profile. For durable card-generation preferences,
    call this first for immediate effect, then call
    `profile_preference_merge` so the preference becomes part of the
    long-term profile. To change the OUTPUT LANGUAGE, use
    `set_generation_language` instead — that's a setting, not a
    preference."""
    evidence = {"card_id": card_id} if card_id else None
    return await http_client.post(
        "/api/agent/preferences/add",
        {
            "statement": statement,
            "scope": scope,
            "polarity": polarity,
            "durability": durability,
            "expiresAt": expires_at.isoformat() if expires_at else None,
            "evidence": evidence,
        },
    )


class SetGenerationLanguageInput(BaseModel):
    language: str = Field(
        min_length=2, max_length=10,
        description=(
            "BCP-47-ish language code the user asked for going forward: "
            "'en', 'zh-Hans', 'ja', 'ko', 'es', 'fr', 'de', 'pt'."
        ),
    )


@tool("set_generation_language", args_schema=SetGenerationLanguageInput)
async def set_generation_language(language: str):
    """Change the language future cards are generated in, when the user
    says something like "use English from now on" / "以后用中文". This
    flips a deterministic setting and re-stamps the generation schedule —
    do NOT route a language request through `preference_add`, because
    language must take effect for sure on the next batch."""
    return await http_client.post(
        "/api/agent/profile/settings/generation-language",
        {"generationLanguage": language},
    )
