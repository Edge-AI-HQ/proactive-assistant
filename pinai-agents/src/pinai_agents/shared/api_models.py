"""Pydantic request/response models shared between web and chat.

Keep these models lean and unchanged across `/api/*` and `/api/agent/*` —
the only difference between the two surfaces is the auth dependency, not
the data shapes. Front-end consumes the camelCase aliases (matching the
existing TS contract); SDK consumers in the chat process get the snake_case
attribute names.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _CamelModel(BaseModel):
    """Base for response models — front-end gets camelCase keys, Python
    holds snake_case attrs. populate_by_name lets us assign by either."""

    model_config = ConfigDict(
        alias_generator=lambda n: _to_camel(n),
        populate_by_name=True,
    )


def _to_camel(snake: str) -> str:
    parts = snake.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


# ── Memory ──
class MemoryItem(_CamelModel):
    id: str
    text: str
    source: str
    source_run_id: str | None = None
    subject: str | None = None
    quality: float
    confidence: float
    status: str
    superseded_by: str | None = None
    occurred_at: datetime | None = None
    created_at: datetime
    tags: list[str] = Field(default_factory=list)
    related_memory_ids: list[str] = Field(default_factory=list)
    reference_count: int = 0
    last_referenced_at: datetime | None = None


class MemoryListResponse(_CamelModel):
    items: list[MemoryItem]


class MemoryCreateRequest(_CamelModel):
    text: str = Field(min_length=1, max_length=10_000)
    source: str = Field(min_length=1, max_length=200)
    subject: str | None = Field(default=None, max_length=200)
    quality: float = Field(default=0.5, ge=0, le=1)
    confidence: float = Field(default=0.5, ge=0, le=1)
    source_run_id: str | None = None
    occurred_at: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    id: str | None = None  # caller can supply; auto-generate if None


class MemorySupersedeRequest(_CamelModel):
    old_id: str
    new_id: str


# ── Personal Signals ──
class PersonalSignalItem(_CamelModel):
    id: str
    kind: str
    title: str
    summary: str
    payload: dict[str, Any] = Field(default_factory=dict)
    salience: float
    confidence: float
    dedupe_key: str | None = None
    occurred_at: datetime
    available_at: datetime
    expires_at: datetime | None = None
    source: str
    device_id: str | None = None
    subject: str | None = None
    status: str
    consumed_by_run_id: str | None = None
    ingested_at: datetime


class PersonalSignalListResponse(_CamelModel):
    items: list[PersonalSignalItem]


class PersonalSignalIngestRequest(_CamelModel):
    id: str | None = None
    kind: str
    title: str
    summary: str
    occurred_at: datetime
    payload: dict[str, Any] = Field(default_factory=dict)
    salience: float = 0.0
    confidence: float = 0.0
    dedupe_key: str | None = None
    available_at: datetime | None = None
    expires_at: datetime | None = None
    source: str = "device"
    device_id: str | None = None
    subject: str | None = None
    source_raw_table: str | None = None
    source_raw_ids: list[str] = Field(default_factory=list)


class PersonalSignalConsumeRequest(_CamelModel):
    id: str
    run_id: str


# ── Profile / Goals / Settings ──
class ProfileResponse(_CamelModel):
    profile: dict[str, Any] | None
    goals: list[dict[str, Any]]
    settings: dict[str, Any] | None


class GoalUpsertRequest(_CamelModel):
    id: str | None = None
    key: str
    title: str
    priority: Literal["low", "medium", "high"] = "medium"
    status: str = "active"
    summary: str | None = None


class ProfileUpsertRequest(_CamelModel):
    """Partial-update payload — every field optional. Missing fields keep
    the existing value (server-side COALESCE). Profile id is implicit
    ("primary") — we don't expose multi-profile to the agent surface."""

    display_name: str | None = Field(default=None, max_length=200)
    locale: str | None = Field(default=None, max_length=20)
    timezone: str | None = Field(default=None, max_length=64)
    summary: str | None = Field(default=None, max_length=2000)
    facts: dict[str, Any] | None = None
    preferences: dict[str, Any] | None = None
    constraints: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class SettingsUpdateRequest(_CamelModel):
    generation_language: str | None = None
    auto_generate: bool | None = None
    auto_dreaming: bool | None = None
    auto_crystallize: bool | None = None
    metadata: dict[str, Any] | None = None


# ── App State KV ──
class AppStateValue(_CamelModel):
    value: Any


# ── Generate / Run ──
class GenerateRequest(_CamelModel):
    cards_to_generate: int = Field(default=8, ge=1, le=10)
    output_language: str = "en"


class GenerateResponse(_CamelModel):
    run_id: str
    status: str
    duration_ms: int
    cards: list[dict[str, Any]]
    evaluations: list[dict[str, Any]]
    batch_feedback: str | None = None
    reasoning: str | None = None


# ── Generator subagent contracts ──
# Pydantic models that drive the agent's `response_format`. Replacing
# our hand-written JSON-parsing path: each subagent emits a validated
# instance of one of these (deepagents marshals it back through the
# `task` tool as the subagent's structured_response).
#
# Field naming: snake_case here so the subagent prompts can use Python-
# native identifiers; the camelCase wire output is restricted to the
# top-level `GenerateResponse` (UI contract). _CamelModel is NOT used
# below — these are agent-internal contracts, not HTTP wire shapes.

class _AgentModel(BaseModel):
    """Strict variant — extra fields rejected so the LLM can't smuggle
    free-form prose into a structured response. Also camelCase aliases
    so the wire shape (passed through to the frontend) stays compatible
    with the existing IntentCard contract (whyNow / primaryAction /
    intentKey / etc.)."""

    model_config = ConfigDict(
        extra="forbid",
        alias_generator=_to_camel,
        populate_by_name=True,
    )


class PlanItem(_AgentModel):
    """One planned card — high-level intent only, the card body comes
    from the card-generator subagent."""

    intent_key: str = Field(
        min_length=1, max_length=120,
        description="Stable slug identifying this intent (e.g. 'brex-vendor-card-limit'). Used for downstream dedup with `cards.recent`.",
    )
    goal_basket: Literal["work", "health", "family", "wealth", "growth", "life"]
    decision: str = Field(
        min_length=1, max_length=200,
        description="One sentence describing the decision the user can make.",
    )
    why_now_trigger: str = Field(
        min_length=1, max_length=200,
        description="The concrete event/date/number that makes this timely RIGHT NOW.",
    )
    primary_source_ids: list[str] = Field(
        default_factory=list,
        description="ids from phase 1 data (signal/memory/gmail/gcal) that ground this plan.",
    )


class PlanOutput(_AgentModel):
    plan: list[PlanItem]
    skipped_duplicates: list[str] = Field(
        default_factory=list,
        description="intent_keys / titles from cards.recent that the planner explicitly chose NOT to repeat. Audit trail.",
    )
    cold_baskets: list[str] = Field(
        default_factory=list,
        description="goal baskets the planner is treating as cold (recent dismisses without strong new evidence).",
    )
    notes: str = Field(
        default="", max_length=3000,
        description="One-paragraph rationale: how plan reflects fresh signals, dedup, and feedback alignment.",
    )


class CardAction(_AgentModel):
    label: str = Field(min_length=1, max_length=80)
    type: Literal["confirm", "modify", "snooze", "dismiss"] = "confirm"


class GeneratedCard(_AgentModel):
    """A complete card — wire-compatible with the frontend's IntentCard
    contract (proactive-ai-frontend reads these fields)."""

    intent_key: str = Field(min_length=1, max_length=120)
    goal_basket: Literal["work", "health", "family", "wealth", "growth", "life"]
    title: str = Field(min_length=1, max_length=120)
    why_now: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=1500)
    primary_action: CardAction
    secondary_actions: list[CardAction] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    urgency: float = Field(ge=0, le=1)
    importance: float = Field(ge=0, le=1)
    sources: list[str] = Field(
        min_length=1,
        description="Verbatim citations from phase 1 data: 'signal id=..., title=...', 'memory id=..., text=...', 'gmail message id=..., subject=...', etc. min_length=1 enforces grounding at the schema layer.",
    )


class CardsList(_AgentModel):
    cards: list[GeneratedCard]
    skipped_plan_items: list[str] = Field(
        default_factory=list,
        description="intent_keys from the plan that were dropped during generation (insufficient grounding, duplicate angle, etc.).",
    )


class CardEvaluation(_AgentModel):
    intent_key: str
    relevance: float = Field(ge=0, le=10)
    actionability: float = Field(ge=0, le=10)
    why_now_clarity: float = Field(ge=0, le=10)
    novelty: float = Field(ge=0, le=10)
    decision_compression: float = Field(ge=0, le=10)
    overall: float = Field(ge=0, le=10)
    pass_: bool = Field(
        alias="pass",
        description="overall >= 5.0 AND no grounding violation observed in sources[].",
    )
    feedback: str = Field(
        max_length=3000,
        description="Critic's per-card note. gpt-5.5 evaluator naturally writes long, multi-paragraph critiques when scoring across 5 dims; budget generously rather than forcing truncation.",
    )


class EvalReport(_AgentModel):
    evaluations: list[CardEvaluation]
    batch_feedback: str = Field(
        max_length=3000,
        description="Cross-card observations: dedup audit, source attribution quality, basket distribution, weakest card and why.",
    )


class GeneratorOutput(_AgentModel):
    """Top-level structured response from the orchestrator main agent.

    The orchestrator assembles cards (from card-generator subagent) +
    evaluations (from evaluator subagent) + dropping any cards that
    failed self-review."""

    reasoning: str = Field(
        max_length=3000,
        description="One-paragraph rationale: which subagents fired, dedup decisions, basket distribution, why count == N.",
    )
    cards: list[GeneratedCard]
    evaluations: list[CardEvaluation]
    batch_feedback: str = Field(max_length=3000)


# ── Chat ──
class ChatInitRequest(_CamelModel):
    session_key: str | None = None
    card_id: str | None = None


class ChatInitResponse(_CamelModel):
    """Frontend reads `existing` to decide whether to bootstrap a fresh
    card-chat first turn (existing=false) vs replay history (existing=true).
    `ok` is included so the wire format matches the surrounding /api/* shape
    even though we don't expose anything that can fail soft here."""

    ok: bool = True
    session_key: str
    existing: bool = False


class ChatHistoryResponse(_CamelModel):
    """Mirrors chat worker /agent/chat/history shape — frontend renders
    each entry as a thread message via assistant-ui's runtime adapter."""

    ok: bool = True
    messages: list[dict[str, Any]] = Field(default_factory=list)


class ChatSendRequest(_CamelModel):
    session_key: str = Field(min_length=1, max_length=200)
    # `message` is optional: card-chat bootstrap (an empty thread with
    # cardContext) lets the agent produce the opening turn from the card
    # alone. Frontend `buildChatRequestBody` omits this field in that
    # case, so requiring it 422'd those requests. Plain user-typed
    # messages still flow as before — non-empty strings up to 8000 chars.
    message: str | None = Field(default=None, max_length=8000)
    card_context: dict[str, Any] | None = None


# ── Scheduled Tasks ──
class ScheduledTaskItem(_CamelModel):
    id: str
    kind: str
    name: str | None = None
    trigger_kind: str
    cron_expr: str | None = None
    interval_seconds: int | None = None
    status: str
    next_run_at: datetime | None = None
    last_run_at: datetime | None = None
    last_run_status: str | None = None
    run_count: int


class ScheduledTaskUpsertRequest(_CamelModel):
    id: str
    kind: str
    trigger_kind: Literal["schedule", "event", "once"]
    cron_expr: str | None = None
    interval_seconds: int | None = None
    next_run_at: datetime | None = None
    name: str | None = None
    prompt: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    timezone: str = "UTC"
    status: str = "active"
