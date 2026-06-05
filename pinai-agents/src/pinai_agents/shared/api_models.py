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

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator


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
    source_raw_table: str | None = None
    source_raw_ids: list[str] = Field(default_factory=list)
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
# Generation language whitelist — server bound, frontend mirrors this in
# `types/intent-card.ts:GENERATION_LANGUAGE_OPTIONS`. Keep in sync.
SupportedLanguage = Literal[
    "en",
    "zh-Hans",
    "ja",
    "ko",
    "es",
    "fr",
    "de",
    "pt",
]


class AmbientSourceConsent(_CamelModel):
    """Per-source consent record for the mobile ambient capture pipeline.

    Privacy invariant (docs/plans/2026-05-12-v2-to-v3-migration.mdx D-5):
    the mobile client only starts a source when ``enabled is True``.
    ``updated_at`` is server-stamped on every change so the SPA can show
    "last toggled" without a separate event log.
    """

    enabled: bool
    updated_at: datetime | None = None


class SettingsResponse(_CamelModel):
    """User-settings wire shape — typed counterpart to UserSettingsRow."""

    generation_language: SupportedLanguage
    auto_generate: bool
    auto_generate_interval_minutes: int
    auto_dreaming: bool
    auto_crystallize: bool
    metadata: dict[str, Any]
    # Keyed by source slug (sound_classifier, location, visit, activity,
    # barometer, media_notebook, etc.). Missing keys = no consent.
    ambient_sources: dict[str, AmbientSourceConsent] = Field(default_factory=dict)
    # Push notification opt-in for "new cards generated". OS-level
    # permission lives outside this payload — frontend reconciles the two
    # in the Account toggle UI.
    notify_new_cards: bool = False
    # NULL = in-app pre-prompt has never been shown for this user. Flips
    # to a timestamp the first time the user sees the sheet (regardless
    # of which CTA they pick) so we never re-prompt automatically.
    notify_permission_prompted_at: datetime | None = None
    # NULL = the user hasn't completed (or skipped through) the first-run
    # onboarding flow yet. Frontend gates <OnboardingFlow /> vs the main
    # shell on this field. Monotonic — never returns to NULL.
    onboarding_completed_at: datetime | None = None
    updated_at: datetime


class ProfileResponse(_CamelModel):
    profile: dict[str, Any] | None
    goals: list[dict[str, Any]]
    settings: SettingsResponse | None


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
    generation_language: SupportedLanguage | None = None
    auto_generate: bool | None = None
    auto_generate_interval_minutes: int | None = Field(default=None, ge=15, le=1440)
    auto_dreaming: bool | None = None
    auto_crystallize: bool | None = None
    metadata: dict[str, Any] | None = None
    # Partial patch — keys present in this map are merged into
    # pai_user_settings.ambient_sources; keys with ``null`` value are
    # removed; other keys keep their server-side state. Pass ``{}`` to
    # touch nothing (no-op).
    ambient_sources: dict[str, AmbientSourceConsent | None] | None = None
    notify_new_cards: bool | None = None
    # Pass `true` to stamp `notify_permission_prompted_at = NOW()` on the
    # server (the only meaningful write — we never re-clear this column).
    # `false`/omitted is a no-op so a generic toggle update doesn't
    # accidentally mark the prompt as shown.
    notify_permission_prompted: bool | None = None
    # Pass `true` to stamp `onboarding_completed_at = NOW()` (the user
    # finished or skipped through the first-run flow). Same write-only
    # semantics as `notify_permission_prompted` above.
    onboarding_completed: bool | None = None


# ── Preference records ──
# Expression-layer preferences the user states in plain words in main chat.
# `scope` / `polarity` mirror the CHECK constraints in
# 056_pai_preference_records.sql. Frontend has no direct write surface —
# these come through the chat agent's native tools only.
PreferenceScope = Literal["topic", "source", "timing", "format", "global"]
PreferencePolarity = Literal["positive", "negative"]
PreferenceDurability = Literal["temporary", "persistent"]
DevelopmentFeedbackCategory = Literal[
    "ui",
    "feature",
    "bug_like",
    "workflow",
    "settings",
    "other",
]
DevelopmentFeedbackSurface = Literal[
    "main_chat",
    "card_detail",
    "settings",
    "ambient",
    "unknown",
]
DevelopmentFeedbackStatus = Literal["new", "reviewed", "planned", "closed"]
DevelopmentFeedbackSource = Literal["user", "internal_operator", "agent"]


class PreferenceItem(_CamelModel):
    id: str
    statement: str
    scope: PreferenceScope
    polarity: PreferencePolarity
    weight: float
    confidence: float | None = None
    source: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    durability: PreferenceDurability
    expires_at: datetime | None = None
    status: str
    superseded_by: str | None = None
    created_at: datetime
    updated_at: datetime


class PreferenceListResponse(_CamelModel):
    items: list[PreferenceItem]


class PreferenceAddRequest(_CamelModel):
    """Agent-supplied preference fields. `source` is NOT here on purpose —
    the route stamps it from the JWT principal so the agent cannot claim
    a write came from the user when it came from an internal operator
    (and vice-versa). `weight` / `confidence` are optional; the route
    defaults them (user-stated preferences are high-weight by design)."""

    statement: str = Field(min_length=1, max_length=2000)
    scope: PreferenceScope
    polarity: PreferencePolarity
    weight: float | None = Field(default=None, ge=0, le=1)
    confidence: float | None = Field(default=None, ge=0, le=1)
    durability: PreferenceDurability = "persistent"
    expires_at: datetime | None = None
    # Free-form provenance the agent may attach (e.g. `{"card_id": "..."}`
    # when the preference came from feedback on a specific card). The route
    # overwrites `operator_id` here for internal-operator writes.
    evidence: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_lifetime(self) -> PreferenceAddRequest:
        if self.durability == "temporary" and self.expires_at is None:
            raise ValueError("temporary preferences require expires_at")
        if self.durability == "persistent" and self.expires_at is not None:
            raise ValueError("persistent preferences must not set expires_at")
        return self


class PreferenceSupersedeRequest(_CamelModel):
    old_id: str
    new_id: str


class ProfilePreferenceMergeRequest(_CamelModel):
    """Merge a single durable preference into pai_profile.preferences.

    The profile JSONB bucket is normally wholesale-replaced by
    ProfileUpsertRequest. This request is the safe one-key merge path for
    chat tools so adding a durable preference cannot wipe sibling profile
    entries.
    """

    key: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=2000)


class ImpersonationMintRequest(_CamelModel):
    """Internal-dashboard request to mint a chat token acting AS a target
    user. `target_supabase_user_id` is the Supabase UUID (the stable
    external identifier — never the BIGINT users.id)."""

    target_supabase_user_id: str = Field(min_length=1, max_length=64)


class GenerationLanguageSetRequest(_CamelModel):
    """Agent-driven language switch — flips `generation_language` and
    re-stamps the auto-generate schedule payload, the same deterministic
    path the UI settings route uses."""

    generation_language: SupportedLanguage


class DevelopmentFeedbackLogRequest(_CamelModel):
    """Product development suggestion. This is not a personalization
    preference; it is product triage data for feature/UI/workflow requests
    the agent cannot implement immediately."""

    text: str = Field(min_length=1, max_length=4000)
    category: DevelopmentFeedbackCategory
    surface: DevelopmentFeedbackSurface = "unknown"
    summary: str | None = Field(default=None, max_length=500)
    conversation_id: str | None = Field(default=None, max_length=200)
    message_id: str | None = Field(default=None, max_length=200)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DevelopmentFeedbackItem(_CamelModel):
    user_id: StrictInt
    supabase_user_id: str
    id: str
    text: str
    summary: str | None
    category: DevelopmentFeedbackCategory
    surface: DevelopmentFeedbackSurface
    status: DevelopmentFeedbackStatus
    source: DevelopmentFeedbackSource
    conversation_id: str | None
    message_id: str | None
    metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class DevelopmentFeedbackCreateResponse(_CamelModel):
    received: bool
    item: DevelopmentFeedbackItem


# ── App State KV ──
class AppStateValue(_CamelModel):
    value: Any


# ── Generate / Run ──
class MatchedPatternPayload(_CamelModel):
    """One pattern matched by the web-side `pattern_matcher` service.

    Forwarded to the chat process via `GenerateRequest.matched_patterns`
    so the chat-side generator never has to read `pai_card_patterns` directly
    (trust boundary — chat must not touch the pattern DB).
    """

    pattern_id: str
    category: str
    intent: str
    abstract: str
    human_insight: str = ""
    card_skeleton: dict[str, Any] = Field(default_factory=dict)
    subtype: str | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)
    base_hit_rate: float = 0.0
    user_fit_score: float | None = None
    combined_score: float | None = None


class GenerateRequest(_CamelModel):
    cards_to_generate: StrictInt = Field(default=8, ge=1, le=8)
    # None → fall back to user's `generation_language` setting at the
    # route boundary. Explicit value (admin / A-B / debug) overrides.
    output_language: SupportedLanguage | None = None
    # Pattern matcher output from the web side. Optional so legacy callers
    # (and unit tests) can omit it and fall back to free-LLM generation.
    matched_patterns: list[MatchedPatternPayload] = Field(default_factory=list)


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
        min_length=1,
        max_length=120,
        description="Stable slug identifying this intent (e.g. 'brex-vendor-card-limit'). Used for downstream dedup with `cards.recent`.",
    )
    goal_basket: Literal["work", "health", "family", "wealth", "growth", "life"]
    decision: str = Field(
        min_length=1,
        max_length=200,
        description="One sentence describing the decision the user can make.",
    )
    why_now_trigger: str = Field(
        min_length=1,
        max_length=200,
        description="The concrete event/date/number that makes this timely RIGHT NOW.",
    )
    primary_source_ids: list[str] = Field(
        default_factory=list,
        description="ids from phase 1 data (signal/memory/gmail/gcal/connected_raw) that ground this plan.",
    )
    pattern_id: str | None = Field(
        default=None,
        max_length=120,
        description="Pattern (from matched_patterns input) this plan item realizes. Empty when the planner falls back to free-LLM generation.",
    )


class PlanOutput(_AgentModel):
    plan: list[PlanItem] = Field(
        default_factory=list,
        description="Planned cards. Empty is allowed when no source can ground a card; downstream route rejects empty user-facing batches.",
    )
    skipped_duplicates: list[str] = Field(
        default_factory=list,
        description="intent_keys / titles from cards.recent that the planner explicitly chose NOT to repeat. Audit trail.",
    )
    cold_baskets: list[str] = Field(
        default_factory=list,
        description="goal baskets the planner is treating as cold (recent dismisses without strong new evidence).",
    )
    notes: str = Field(
        default="",
        max_length=3000,
        description="One-paragraph rationale: how plan reflects fresh signals, dedup, and feedback alignment.",
    )
    selected_pattern_ids: list[str] = Field(
        default_factory=list,
        description="Pattern ids the planner chose from `matched_patterns`. Mirrors plan[].pattern_id, surfaced once for fast lookup.",
    )


class CardAction(_AgentModel):
    label: str = Field(min_length=1, max_length=80)
    type: Literal["confirm", "modify", "snooze", "dismiss"] = "confirm"
    # Full task instruction the Card Execution agent carries out when the user
    # confirms — distinct from the short button `label`. Serializes to camelCase
    # `agentPrompt`. Optional: pre-existing cards and non-confirm actions omit
    # it, and the frontend falls back to `label`.
    agent_prompt: str | None = Field(default=None, max_length=600)


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
        description="Verbatim citations from phase 1 data: 'signal id=..., title=...', 'memory id=..., text=...', 'gmail message id=..., subject=...', 'slack message id=..., text=...', 'gdrive file id=..., name=...', etc. min_length=1 enforces grounding at the schema layer.",
    )


class CardsList(_AgentModel):
    cards: list[GeneratedCard] = Field(
        default_factory=list,
        description="Generated cards. Empty is allowed for no-grounded-candidate/error shells; the HTTP route must reject empty user-facing batches before persistence.",
    )
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
    # Phase 2 sixth dimension. When card claims a pattern_id, evaluator
    # checks: (a) sources[] contains all signals_required for that
    # pattern, (b) at least N distinct sources are cited so the trigger
    # combination is actually grounded. Score 0 = no pattern claim or
    # grounding violation; 10 = full skeleton compliance.
    pattern_grounding: float = Field(default=0.0, ge=0, le=10)
    overall: float = Field(ge=0, le=10)
    pass_: bool = Field(
        alias="pass",
        description="overall >= 5.0 AND no grounding violation observed in sources[] AND (pattern_grounding == 0 OR pattern_grounding >= 5).",
    )
    pattern_id: str | None = Field(
        default=None,
        max_length=120,
        description="Pattern this card was generated for (mirrored from PlanItem). Used by web side to persist pai_card_pattern_hits.",
    )
    pattern_grounding_ok: bool = Field(
        default=False,
        description="True when the card's sources[] satisfy the pattern's required signal types. Only meaningful when pattern_id is set.",
    )
    feedback: str = Field(
        max_length=8000,
        description="Critic's per-card note. The evaluator naturally writes long, multi-paragraph critiques when scoring across 5 dims; budget generously rather than forcing truncation.",
    )


class EvalReport(_AgentModel):
    evaluations: list[CardEvaluation] = Field(
        default_factory=list,
        description="Evaluations for generated cards. Empty is allowed when no cards were generated.",
    )
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
    cards: list[GeneratedCard] = Field(
        default_factory=list,
        description="Passing generated cards, or empty when the orchestrator returns an error/no-grounded-candidate shell.",
    )
    evaluations: list[CardEvaluation] = Field(
        default_factory=list,
        description="Evaluation audit rows. Empty is allowed for error/no-grounded-candidate shells.",
    )
    batch_feedback: str = Field(max_length=3000)


# ── Chat ──
class ChatInitRequest(_CamelModel):
    """Body for POST /api/chat-stream/init.

    All fields are optional. The backend resolution order is:
      1. session_key explicit (FE cache hit / card resume)
      2. card_id (card chat first-open → derives card-thread-<id>)
      3. neither (main chat) → singleton per-user main thread
    """

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
    # Pagination cursor for "load older": the smallest message id in this
    # page when more history may exist before it (else None). Frontend passes
    # it back as `beforeId` to fetch the previous (older) page.
    next_cursor: int | None = None


class ClientHints(_CamelModel):
    """Frontend-supplied device hints, forwarded to the chat worker.

    Used by browser_tool.open to size + UA the remote Browserbase session
    so mobile users see mobile layouts at 1:1 CSS-px scaling. None of
    these are sensitive — the worker re-validates and clamps.
    """

    viewport_width: int = Field(ge=200, le=4096)
    viewport_height: int = Field(ge=200, le=4096)
    device_kind: Literal["mobile", "tablet", "desktop"] = "desktop"


class ChatSendRequest(_CamelModel):
    session_key: str = Field(min_length=1, max_length=200)
    # Non-empty for normal sends (user-typed text or a synthesized intent
    # like a card "Confirm" → primaryAction). Allowed to be empty ONLY
    # when `regenerate=True`, in which case the chat worker pops the
    # trailing AI / Tool messages from LangGraph state and resumes the
    # run from the existing HumanMessage already at the tail.
    message: str = Field(default="", max_length=8000)
    card_context: dict[str, Any] | None = None
    client_hints: ClientHints | None = None
    # When True, drop the trailing AIMessage(s) + ToolMessage(s) from the
    # LangGraph thread state, then resume the agent from the existing
    # HumanMessage. Powers the frontend's "Regenerate" (on the last
    # assistant turn) and "Retry" (on the last user turn) actions —
    # both reduce to the same backend op: pop tail, rerun.
    regenerate: bool = False


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
