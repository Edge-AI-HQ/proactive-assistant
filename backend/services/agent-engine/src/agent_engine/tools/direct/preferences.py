"""Output-language switch native @tool — main chat uses this.

`set_generation_language` flips a deterministic output-language setting (NOT a
preference row), so the next generation actually comes back in the new language
instead of hoping the planner reads a row. Durable CONTENT preferences ("show
me more A-share news", "stop pushing work cards") are recorded as L1 events now
(`event_append` with `event_type='preference'`), not a dedicated tool.
"""

from __future__ import annotations

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class SetGenerationLanguageInput(BaseModel):
    language: str = Field(
        min_length=2,
        max_length=10,
        description=(
            "BCP-47-ish language code the user asked for going forward: "
            "'en', 'zh-Hans', 'ja', 'ko', 'es', 'fr', 'de', 'pt'."
        ),
    )


@tool("set_generation_language", args_schema=SetGenerationLanguageInput)
async def set_generation_language(language: str):
    """Change the language future cards are generated in, when the user says
    something like "use English from now on" / "以后用中文". This flips a
    deterministic setting and re-stamps the generation schedule, so the new
    language takes effect for sure on the next batch."""
    return await http_client.post(
        "/api/agent/settings/generation-language",
        {"generationLanguage": language},
    )
