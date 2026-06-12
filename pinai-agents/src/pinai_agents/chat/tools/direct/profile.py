"""Profile + Goals native @tool wrappers."""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client


class ProfileGetInput(BaseModel):
    pass


@tool("profile_get", args_schema=ProfileGetInput)
async def profile_get():
    """Fetch user's profile + active goals snapshot. Use as first call
    when starting a new conversation thread to ground replies in the
    user's persona."""
    return await http_client.get("/api/agent/profile/get")


class ProfileUpsertInput(BaseModel):
    """Partial update — pass ONLY fields the user just clarified.
    Omitted fields keep their existing value; passing a value overwrites
    that field. Use this for structured persona attributes, not free-form
    facts (those go into `memory_add`)."""

    display_name: str | None = Field(
        default=None,
        max_length=200,
        description="User's preferred display name. Set when the user introduces themselves or asks to be called something specific.",
    )
    locale: str | None = Field(
        default=None,
        max_length=20,
        description="BCP-47 locale tag, e.g. 'en-US', 'zh-Hans'. Set when the user reveals their language preference.",
    )
    timezone: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "IANA timezone, e.g. 'America/Los_Angeles', 'Asia/Shanghai'. Set "
            "when the user states their location/timezone. Invalid names are "
            "rejected (400). Note: the phone's device timezone is the source "
            "of truth — a value written here is overridden by the next device "
            "sync, so only set it when the user explicitly asks."
        ),
    )
    summary: str | None = Field(
        default=None,
        max_length=2000,
        description="One-paragraph persona summary the agent uses to ground future replies. Rewrite when the user's high-level situation shifts.",
    )
    facts: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Structured persona facts bucket (role, employer, family, etc.). "
            "Each VALUE is a descriptive sentence — *what + evidence + when* — "
            "not a single-word tag. Good: "
            "`facts.employer = 'Founder + software engineer at PIN-AI; "
            "works on the PIN-AI-ASSISTANT repo on refactor/deepagents.'`. "
            "Bad: `facts.employer = 'PIN-AI'` — too thin to ground future "
            "card generation. Replaces the entire facts JSONB; "
            "read-merge-write client-side to preserve sibling keys."
        ),
    )
    preferences: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Structured preferences bucket (communication_style, working_hours, "
            "dietary, tooling, etc.). Each VALUE is a descriptive sentence — "
            "*what + why / when observed*. Good: `preferences.trading_platform "
            "= 'Uses Robinhood for both individual and Roth IRA; trades large-"
            "lot leveraged ETFs and runs daily crypto DCA.'`. Bad: "
            "`preferences.trading_platform = 'Robinhood'`. Replaces the entire "
            "JSONB."
        ),
    )
    constraints: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Structured constraints bucket (no_meetings_before, allergies, "
            "hard_deadlines, etc.). Each VALUE is a descriptive sentence — "
            "*the constraint + scope + source*. Good: `constraints."
            "deep_work_hours = 'Reserves 9–11 AM PT for deep work; declines "
            "meetings in that window unless flagged urgent.'`. Bad: "
            "`constraints.deep_work_hours = '9-11am'`. Replaces the entire JSONB."
        ),
    )


@tool("profile_upsert", args_schema=ProfileUpsertInput)
async def profile_upsert(
    display_name: str | None,
    locale: str | None,
    timezone: str | None,
    summary: str | None,
    facts: dict[str, Any] | None,
    preferences: dict[str, Any] | None,
    constraints: dict[str, Any] | None,
):
    """Persist a structured persona update the user just stated. Use ONLY
    when the user explicitly clarified one of: display name, locale,
    timezone, persona summary, or one of the structured facts /
    preferences / constraints buckets. Free-form one-liner facts
    ("likes coffee black") go to `memory_add`, not here. Long-term named
    goals go to `goal_upsert`. Pass only the fields that changed —
    omitted fields are preserved."""
    return await http_client.post(
        "/api/agent/profile/upsert",
        {
            "displayName": display_name,
            "locale": locale,
            "timezone": timezone,
            "summary": summary,
            "facts": facts,
            "preferences": preferences,
            "constraints": constraints,
        },
    )


class ProfilePreferenceMergeInput(BaseModel):
    key: str = Field(
        min_length=1,
        max_length=120,
        description=(
            "Stable snake_case key for the durable preference inside "
            "pai_profile.preferences, e.g. 'card_topics' or "
            "'work_card_timing'."
        ),
    )
    value: str = Field(
        min_length=1,
        max_length=2000,
        description=(
            "Descriptive sentence for a durable preference: what the user "
            "prefers, why/scope if known, and that it came from an explicit "
            "user statement. Do not use for temporary requests such as "
            "'today show me AI news'."
        ),
    )


@tool("profile_preference_merge", args_schema=ProfilePreferenceMergeInput)
async def profile_preference_merge(key: str, value: str):
    """Merge one durable preference into the profile preferences bucket.
    Use after `preference_add` for long-lived card-generation preferences
    that should affect every future generation. This is safer than
    `profile_upsert(preferences=...)` because it preserves sibling keys."""
    return await http_client.post(
        "/api/agent/profile/preferences/merge",
        {"key": key, "value": value},
    )


class GoalUpsertInput(BaseModel):
    key: str = Field(
        min_length=1,
        max_length=120,
        description="Stable slug for this goal (e.g. 'staff-promo-2026', 'sub3-marathon'). Used to update the same goal across conversations.",
    )
    title: str = Field(
        min_length=1,
        max_length=200,
        description="One-sentence goal statement, action-led with a target/timeframe.",
    )
    id: str | None = Field(
        default=None,
        description="Existing goal id to update. Omit to let the server generate a new id (insert path).",
    )
    priority: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Goal priority. Default 'medium'.",
    )
    status: Literal["active", "archived"] = Field(
        default="active",
        description="'active' for live goals; pass 'archived' to retire one in place (alternative to a separate close call).",
    )
    summary: str | None = Field(
        default=None,
        max_length=2000,
        description="Optional longer description / context that helps future cards reason about this goal.",
    )


@tool("goal_upsert", args_schema=GoalUpsertInput)
async def goal_upsert(
    key: str,
    title: str,
    id: str | None,
    priority: Literal["low", "medium", "high"],
    status: Literal["active", "archived"],
    summary: str | None,
):
    """Persist a long-term named goal the user just declared (career,
    health, family, wealth, growth, life — typically a 90-day or longer
    trajectory). Use a stable `key` slug so subsequent calls update the
    same goal. For one-off tasks or short reminders, use the card / chat
    surface instead, not a goal."""
    return await http_client.post(
        "/api/agent/profile/goals/upsert",
        {
            "id": id,
            "key": key,
            "title": title,
            "priority": priority,
            "status": status,
            "summary": summary,
        },
    )
