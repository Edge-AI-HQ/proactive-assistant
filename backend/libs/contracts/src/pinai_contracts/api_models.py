"""Pydantic request/response models shared between web and chat.

Keep these models lean and unchanged across `/api/*` and `/api/agent/*` —
the only difference between the two surfaces is the auth dependency, not
the data shapes. Front-end consumes the camelCase aliases (matching the
existing TS contract); SDK consumers in the chat process get the snake_case
attribute names.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

logger = logging.getLogger(__name__)


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


# ── Settings ──
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

    # User IANA timezone (device-followed via X-Pin-Client-Timezone). Was on
    # the retired pai_profile; moved to pai_user_settings in the sunset.
    timezone: str
    generation_language: SupportedLanguage
    auto_generate: bool
    auto_generate_interval_minutes: int
    auto_dreaming: bool
    # Per-user "permission mode" for side-effect tools: 'ask' (pause for HITL
    # approval) or 'bypass' (no per-call pause). The composer shows this as a
    # mode menu; persisted, cross-device SSOT. Delivered to chat per-run via
    # request meta (mapped to a bool). TEXT-backed so modes can grow.
    permission_mode: Literal["ask", "bypass"] = "ask"
    # Proactive heartbeat opt-in (the "Proactive" page toggle). Mirrored
    # server-side into a per-user proactive.tick scheduler task.
    proactive_enabled: bool
    # Heartbeat cadence (seconds) — one of {30, 60, 300, 1800}. Mirrored into
    # the proactive.tick task's interval. Default 300 (5 min).
    proactive_interval_seconds: int
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


class SettingsUpdateRequest(_CamelModel):
    generation_language: SupportedLanguage | None = None
    auto_generate: bool | None = None
    auto_generate_interval_minutes: int | None = Field(default=None, ge=1, le=1440)
    auto_dreaming: bool | None = None
    permission_mode: Literal["ask", "bypass"] | None = None
    proactive_enabled: bool | None = None
    # One of the three UI buckets (seconds). Literal pins them so a bad client
    # can't create a runaway heartbeat; the DB CHECK is the backstop.
    proactive_interval_seconds: Literal[60, 300, 1800] | None = None
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
    # Request-scoped generation intent. Scheduled generator uses this to pass
    # the user-confirmed brief into the existing generator pipeline without
    # changing memory retrieval or card persistence.
    generation_request: dict[str, Any] | None = None


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

    @model_validator(mode="before")
    @classmethod
    def _clip_overlong_strings(cls, data: Any) -> Any:
        """Clip (don't reject) over-`max_length` strings from LLM output.

        LLM structured output does NOT enforce JSON-Schema ``maxLength`` —
        neither OpenAI strict ``json_schema`` nor Anthropic tool use guarantees
        string length (only structure/type/enum/required), and the LiteLLM →
        Anthropic path enforces none of it. Treating ``max_length`` as a hard
        validation gate means a single over-long field aborts the whole batch
        (a recurring failure: decision/why_now_trigger 200→400, then
        agentPrompt 600, …). Downgrade to truncation so ``max_length`` stays a
        real UI/DB ceiling while an over-long value is clipped + logged instead
        of raising. Runs at every nesting level: each _AgentModel subclass
        inherits this validator, and Pydantic builds nested models bottom-up.
        """
        if not isinstance(data, dict):
            return data
        for name, field in cls.model_fields.items():
            max_len: int | None = next(
                (
                    m.max_length
                    for m in field.metadata
                    if isinstance(getattr(m, "max_length", None), int)
                ),
                None,
            )
            if max_len is None:
                continue
            # LLM emits camelCase aliases; SDK callers may use snake_case names.
            key = name if name in data else field.alias
            value = data.get(key)
            if isinstance(value, str) and len(value) > max_len:
                logger.warning(
                    "clipped over-long LLM field model=%s field=%s len=%d max=%d",
                    cls.__name__,
                    name,
                    len(value),
                    max_len,
                )
                data[key] = value[:max_len]
        return data


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
        max_length=400,
        description="One sentence (<=400 chars) describing the decision the user can make.",
    )
    why_now_trigger: str = Field(
        min_length=1,
        max_length=400,
        description="The concrete event/date/number (<=400 chars) that makes this timely RIGHT NOW.",
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


class ReasoningStep(_AgentModel):
    """One user-visible step of the card's "How I reasoned" trace.

    Written by the card-generator LLM in the same structured call that
    writes the card; the evaluator audits each detail against sources[]
    (a step referencing un-cited data is a grounding violation)."""

    label: Literal["observed", "cross_referenced", "pattern_matched", "flagged", "decided"]
    detail: str = Field(min_length=1, max_length=200)

    @field_validator("label", mode="before")
    @classmethod
    def _normalize_label(cls, value: Any) -> Any:
        # LLM 偶发 "Cross-referenced" / "Pattern matched" 变体;归一化到
        # 枚举形,避免一个 label 大小写让整张卡验证失败重试。
        if isinstance(value, str):
            return value.strip().lower().replace("-", "_").replace(" ", "_")
        return value


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
    contract (proactive-ai-frontend reads these fields). This model doubles
    as the generator's `submit_card` args_schema, so every description below
    is agent-facing prompt text — keep it consistent with the generator
    instructions (a stale description here once contradicted them)."""

    intent_key: str = Field(
        min_length=1,
        max_length=120,
        description="Stable kebab-case slug naming the underlying decision, verb-object-qualifier style (e.g. 'review-tech-concentration-selloff'). Same decision → same key: it is the dedupe anchor.",
    )
    goal_basket: Literal["work", "health", "family", "wealth", "growth", "life"] = Field(
        description="Life area served: work=job/career, health=body/mind, family=relationships/people, wealth=money/investments, growth=learning/skills, life=everything else (errands, travel, leisure).",
    )
    title: str = Field(min_length=1, max_length=120)
    why_now: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=1500)
    primary_action: CardAction
    secondary_actions: list[CardAction] = Field(
        default_factory=list,
        description="0-2 genuinely different handlings of the same decision (not variants of the primary). Usually empty.",
    )
    confidence: float = Field(
        ge=0,
        le=1,
        description="Grounding solidity: 0.9+ = every claim verified against cited events; 0.6-0.8 = core fact verified, some inference; below 0.6 = speculative — don't submit those.",
    )
    urgency: float = Field(
        ge=0,
        le=1,
        description="Time pressure: 0.9+ = acting today prevents a real loss (the UI shows an Urgent tag from 0.85 up — reserve it accordingly); 0.6-0.8 = should be handled this week; 0.5 and below = no clock attached.",
    )
    importance: float = Field(
        ge=0,
        le=1,
        description="Stakes if ignored: 0.9+ = material impact (money/career/health/relationships); 0.6-0.8 = meaningful but recoverable; 0.5 and below = minor convenience.",
    )
    sources: list[str] = Field(
        min_length=1,
        description="Verbatim citations of events you actually saw, each exactly '{toolkit} event id={event id}, title={title}' — toolkit from the event's `toolkit` field (e.g. gmail, googlecalendar), or the event source for non-connector events (world, device, ambient). Never cite an id you did not see; min_length=1 enforces grounding at the schema layer.",
    )
    reasoning_steps: list[ReasoningStep] = Field(
        default_factory=list,
        description="2-4 user-visible steps narrating how this card came to be, in order: observed -> cross_referenced -> decided. Each detail must reference data already cited in sources[]. Serializes to camelCase reasoningSteps.",
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
    """The generator tick's return envelope (code-constructed — no longer an
    LLM structured output since the agentic rewrite; the agent submits cards
    through the submit_card tool and this wraps the collected result)."""

    reasoning: str = Field(
        max_length=3000,
        description="The agent's closing summary: what it saw, why these cards / no cards.",
    )
    cards: list[GeneratedCard] = Field(
        default_factory=list,
        description="Cards submitted this tick (0..N; 0 is a normal outcome).",
    )
    evaluations: list[CardEvaluation] = Field(
        default_factory=list,
        description="Always empty — the evaluator stage is retired; kept for wire compat.",
    )
    batch_feedback: str = Field(max_length=3000)
    # Usage of the tick's largest model call — observability (real-usage
    # calibration against the engine's token estimate). None/0 when the
    # provider returned no usage.
    prompt_tokens: int | None = Field(default=None, ge=0)
    cache_read_tokens: int | None = Field(default=None, ge=0)
    # The anchor this tick actually built on: == the request anchor normally,
    # == now after an in-place budget reset (design §4.2). The api side
    # persists THIS value — it is the one piece of generator state.
    effective_anchor: datetime | None = Field(default=None)
