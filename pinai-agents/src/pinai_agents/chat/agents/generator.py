"""Unified generator fixed pipeline.

Topology:

    run_generator()
      ├─ deterministic context builder — web agent APIs, no LLM
      ├─ planner structured call      — sonnet, response_format=PlanOutput
      ├─ card-generator structured    — sonnet, response_format=CardsList
      └─ evaluator structured         — sonnet, response_format=EvalReport

Why 4 stages instead of one big prompt:

  - Context isolation: the builder collects the full 24h/last-cycle
    artifact, then source-index compaction ensures each LLM call sees
    only what it needs to decide.
  - Specialization: planner reasons about dedup / feedback alignment;
    generator focuses on writing high-quality cards; evaluator reviews
    them with a CRITIC prompt against the same CardsList output.
  - Schema enforcement at the LLM layer: each structured stage's
    `response_format` is a Pydantic model, validated by the model
    runtime. Replaces the old hand-written `parse_generator_output` +
    `is_complete_generator_output` + grounding checks (now schema-level
    via `min_length=1` on `sources[]`).

Why share one sandbox backend:
  No sandbox is needed for collection anymore. Chat reads web's agent
  APIs directly with the per-run JWT, so collection is deterministic and
  still respects the web/chat trust boundary.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ...shared.api_models import (
    CardsList,
    EvalReport,
    GeneratorOutput,
    PlanOutput,
)
from ..harness.ctx import run_context
from ..harness.llm import make_chat_model
from .generation_context import _connection_toolkit, build_generation_context

logger = logging.getLogger(__name__)

_MAX_SOURCE_PAYLOAD_CHARS = 700
_MAX_SOURCE_SNIPPET_CHARS = 360
_MAX_PLANNER_SOURCES = 80
_MAX_BUNDLE_SOURCES = 8
_CARD_STAGE_CONCURRENCY = 4
# Each structured stage (planner / card writer / evaluator) is one LLM call.
# dev chat workers churn (lease-expired / ConnectError / timeout under
# concurrency), so a single transient blip used to kill a whole card. Retry
# the call a couple times before giving up.
_STRUCTURED_STAGE_MAX_ATTEMPTS = 3
_STRUCTURED_STAGE_RETRY_BACKOFF_S = 1.5
_MAX_TOPUP_ROUNDS = 2


class FinalSelection(BaseModel):
    """Final small-context editor pass over already generated cards."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    selected_intent_keys: list[str] = Field(
        default_factory=list,
        alias="selectedIntentKeys",
        description="Intent keys in final display order. Unknown keys are ignored.",
    )
    rejected_intent_keys: list[str] = Field(
        default_factory=list,
        alias="rejectedIntentKeys",
        description="Candidate intent keys rejected for duplication, weak evidence, or low utility.",
    )
    notes: str = Field(
        default="",
        max_length=3000,
        description="Short rationale for the final curation order.",
    )


# ── Stage prompts ───────────────────────────────────────────────────
# Data collection is deterministic. Structured stages receive compact
# context JSON inline from Python.

_PLANNER_PROMPT = """You are the planner stage of the Pin AI card generator.

<role>
Read the provided phase1 JSON and decide which Intent Cards to generate next.
For an explicit generator run, produce 1-{cards_to_generate} planned
items whenever phase1 contains any usable grounded source. Return zero
items only when every source is empty/error or every candidate would be
unambiguously harmful, hallucinated, or impossible to ground.
Your output is a structured Plan — not the cards themselves. The
card-generator stage will turn each plan item into a full card.
</role>

<workflow>
1. Use `<phase1_json>` — compact context JSON from the deterministic
   context builder.
2. Use `<matched_patterns_json>` — candidates the web-side pattern matcher
   already verified are triggerable. Each item has
   `patternId`, `category`, `intent`, `abstract`, `humanInsight`,
   `cardSkeleton` (including `title_strategy` when available), `evidence`
   (the signal evidence that satisfied the trigger), and a `baseHitRate` score.
3. PREFER plan items that realize a matched pattern: pick `plan_item.pattern_id`
   from the matched list, set `intent_key`/`decision`/`why_now_trigger` so the
   card grounds in the same evidence. When no pattern fits a strong signal,
   you may still propose a plan item with `pattern_id = null` (free-LLM).
4. Reason through dedup and feedback alignment BEFORE proposing items.
5. Emit a PlanOutput with:
     - `plan[]`: each item = {{intent_key, goal_basket, decision,
       why_now_trigger, primary_source_ids, pattern_id}}
     - `selected_pattern_ids[]`: same `pattern_id` values surfaced once
       (deduplicated). Empty when every plan item is `pattern_id = null`.
     - `skipped_duplicates[]`: intent_keys / titles from `cards_recent`
       you explicitly chose NOT to repeat (audit trail)
     - `cold_baskets[]`: baskets you're treating as cold (recent
       dismisses without strong new evidence)
     - `notes`: one paragraph rationale
</workflow>

<dedup_and_feedback_rules>
- A new intent is a duplicate of `cards_recent` if its (intent_key,
  goal_basket, primary subject) overlaps a recent card whose latest
  user action was NOT a dismiss. Skip; record in `skipped_duplicates`.
- If `feedback` shows the user dismissed N cards in basket X within
  the last 7 days, treat X as cold. Only plan an item in X if a NEW
  high-salience signal / calendar event / explicit user intent exists.
  Add X to `cold_baskets` either way.
- If `feedback` shows confirms in basket Y, weight Y higher when
  ranking ties.
- Better to plan FEWER than {cards_to_generate} items than to ship a
  duplicate or a cold-basket item without fresh evidence, but do not
  collapse to zero just because the highest-value items require review,
  update, follow-up, or confirmation rather than a brand-new intent.
</dedup_and_feedback_rules>

<preference_alignment>
`<phase1_json>` has a `preferences` array — the user's OWN stated
preferences (each: statement, scope, polarity, durability, expires_at,
weight, created_at, optional evidence). The list endpoint already filters
out expired temporary rows. Valid active preferences are a HARD CONSTRAINT
on this batch, stronger than inferred signals:

- The most RECENT preferences and the HIGHEST-`weight` ones are near-
  mandatory. Treat a recent, high-weight preference as a rule you must
  obey this run, not a hint to weigh against everything else.
- If valid preferences conflict, follow the newest one for this batch.
  Mention the conflict in `notes` instead of averaging the two.
- `durability = "temporary"` means the user asked for a time-boxed
  generation change (today / next batch / this card). Obey it now but
  do not treat it as evidence of long-term taste.
- `durability = "persistent"` is long-lived. It should usually agree
  with `profile.preferences`; if the two conflict, prefer the newer
  explicit preference for this batch and note the mismatch.
- `polarity = "positive"` → actively BIAS the plan TOWARD that topic /
  source / timing / format. Plan an item that satisfies it when any
  grounded evidence supports one.
- `polarity = "negative"` → SUPPRESS matching items. Do not plan a card
  the user told you they don't want, even if a signal would otherwise
  justify it. Add the basket to `cold_baskets` when a negative
  preference is why you skipped it.
- When a plan item is shaped by a preference, name the preference `id`
  in `notes` so the choice is auditable downstream.
- Preferences outrank cold-basket inference: a positive preference can
  re-warm a basket; a negative preference keeps it cold regardless of
  fresh signals.
- Language is NOT handled here — output language comes from a
  deterministic setting, never from a preference row. Ignore any
  language-shaped preference for planning.
</preference_alignment>

<connected_raw_sources>
`<phase1_json>` includes `connections_summary` (the user's ACTIVE
Composio accounts, one row per toolkit) and `connected_raw` rows
surface inside `sources[]` from each connected, supported source
over the context window. Treat connected raw rows as first-class
fresh evidence alongside Gmail/GCal:

- Connected Slack appears under `connected_raw["slack/messages"]`.
- Connected Google Drive appears under `connected_raw["gdrive/files"]`.
- If a positive preference names a source or topic (for example Boliang
  in Slack, or proactive AI docs in Drive), search the relevant
  `connected_raw` rows before deciding there is no grounded card.
- Do not require connector.evolve to have already converted raw rows into
  memory or personal_signals. Fresh connected raw rows are enough to plan
  a card when they satisfy a valid preference or strong user relevance.
</connected_raw_sources>

<ambient_transcript_attribution>
`<phase1_json>` may include `ambient.candidate_window` signals and
`ambient_signal_details` with full payloads. Speaker labels are evidence
attribution:

- `self:` lines and `payload.self_text` are the user's own speech. Treat
  them as stronger, more direct evidence of user intent than inferred
  ambient context.
- `speaker_1`, `speaker_2`, `A`, `B`, etc. are other people. Use them
  only as surrounding context; never treat their words as the user's
  preference, task, promise, or goal.
- When planning from a transcript, prefer a card grounded in `self`
  speech. If only non-self speech supports an idea, the card should be
  framed as context to review, not as something the user said or wants.
</ambient_transcript_attribution>

<intent_key_convention>
intent_key is a stable slug — kebab-case, ≤120 chars, identifies the
underlying decision (not the card title). Examples:
"brex-vendor-card-limit", "boston-marathon-registration",
"openai-budget-cap". The same intent across runs gets the same key
so dedup is deterministic.
</intent_key_convention>

<connector_guidance_cards>
You may plan cards with intent_key prefix "connect:<toolkit_slug>". These
are SOFT NUDGES to connect a missing Composio data source so future cards
and chat answers get materially better. They are NOT marketing — never
plan one without a real reason.

Valid slugs (use exactly these — the frontend renders icons by slug):
  gmail, google_calendar, slack, github, google_drive, calendly,
  linkedin, stripe, youtube.

Inputs you read to decide:
- `connections_summary[]` — toolkits the user has ALREADY connected
  (status="ACTIVE"). Never nudge a toolkit listed here.
- `cards_recent[].intentKey` + `latestOutcome` — was this same nudge
  already shown? if `latestOutcome` is null (no action yet) or
  positive, do NOT re-plan it; if dismissed, see feedback rule below.
- `feedback[].intentKey` + `outcome` — has the user explicitly
  rejected this connector before? if so, do not re-plan it this run.
- `sources[]` — the user's actual context, used to make the nudge
  SPECIFIC to their data instead of generic.

WHEN to plan one:
  1. SIGNAL-DRIVEN: a `sources[]` entry mentions a domain whose connector
     is NOT in connections_summary as ACTIVE. Examples:
       - a signal mentions a meeting → suggest google_calendar
       - a signal mentions email → suggest gmail
       - a memory mentions a PR/repo → suggest github
       - a signal mentions a Slack thread → suggest slack
     The triggering source MUST be citable in the card's `sources[]`.
  2. COLD-START: connections_summary is empty AND `cards_recent` has
     fewer than 3 entries → plan exactly ONE guidance card. Rotation
     order: gmail → google_calendar → slack. Pick the first slug in
     this list whose `connect:<slug>` is NOT in cards_recent and NOT
     in feedback as a dismiss/snooze.

WHEN NOT to plan one:
  - target toolkit is in connections_summary with status="ACTIVE"
  - same `connect:<toolkit>` intent_key appears in `cards_recent` and
    its `latestOutcome` is null or positive (still pending user action)
  - same `connect:<toolkit>` appears in `feedback` with an outcome
    that signals rejection (dismiss/snooze/negative)

BUDGET per run:
  - cold-start: at most 1 guidance card
  - signal-driven: at most 2 guidance cards, each for a DIFFERENT toolkit

TONE: soft, specific to the user's own data. Never marketing. Never
"You should connect X." The card-generator stage will write the actual
text; planner just decides whether to include the item.
</connector_guidance_cards>

<output>
Your `response_format` is `PlanOutput`. Validation will reject
free-form prose. Stay strictly within the schema.
</output>
"""


_CARD_GENERATOR_PROMPT = """You are the card-generator stage of the Pin AI card generator.

<role>
Take the provided plan and write the actual Intent Cards.
You are the ONLY stage that produces user-facing card text.
</role>

<workflow>
1. Use `<plan_json>` (PlanOutput JSON). For each plan item, write one card.
2. Use `<phase1_json>` to look up any source body you need to cite verbatim
   (gmail subjects, signal summaries, memory text, connected raw rows).
   Don't paraphrase a source name; quote it.
3. When `plan_item.pattern_id` is set, find the matching entry in
   `<matched_patterns_json>`. Use its `evidence` field to ensure every signal
   source the pattern requires actually appears as a verbatim citation in
   `sources[]`. Use `humanInsight` + `cardSkeleton.title_strategy` to choose
   the title angle and action. The pattern's abstract / category should
   inform tone but not be quoted to the user.
4. Output a CardsList with one GeneratedCard per plan item you can
   ground. If a plan item lacks the source data needed to write a
   solid card, drop it and add the intent_key to `skipped_plan_items`.
</workflow>

<card_quality_rules>
Every card must meet ALL:
- title: ≤ 80 chars, specific, and built as "concrete fact / number / time
  + human stake + immediate action". If the matched pattern has
  `cardSkeleton.title_strategy.example`, use it as style calibration, not as
  copy text. Avoid generic "I noticed..." / "you may like..." / "need help?"
  titles.
- whyNow: one sentence with a CONCRETE trigger (date / number / event)
- summary: 2-4 sentences of compressed context — enough to decide
- primary_action: concrete verb + object button label
- primary_action.agent_prompt: the full task the Card Execution agent runs on
  confirm — one sentence naming the concrete deliverable PLUS the key parameters
  drawn from THIS card, so the agent has a real task spec instead of guessing
  intent from the short button label. Required for confirm/modify; omit for
  snooze/dismiss.
- sources: at least one verbatim citation per source layer used,
  formatted as "signal id=sig_..., title=...", "memory id=mem_...,
  text=...", "gmail message id=..., subject=...", "profile id=primary,
  display_name='...', summary='...'", "world id=world_..., title=..."
  (for items pulled from phase1's `world` layer — global news),
  "slack message id=..., user=..., text=...", "gdrive file id=...,
  name=...", etc.
  The reader (evaluator stage) MUST be able to find each cited id
  back in phase1.json. World-signal citations are how downstream
  auto-consume identifies which news items the run actually used.
- ambient transcript citations must preserve attribution. `self:` or
  `payload.self_text` can support user intent; non-self speaker labels
  can support context only. Do not write "you said" unless the cited
  source is `self`.
- {lang_clause}. For Chinese strings, use 「」 or 《》 — NEVER ASCII
  double-quote inside a JSON string field.
</card_quality_rules>

<absolute_dates>
In user-visible text (title / why_now / summary), lead with ABSOLUTE
calendar references ("6月12日 17:00", "2026-09-15", "Jun 26 09:00 PT")
instead of relative counts ("in 8 days", "距今 22 天", "倒计时 8 天").
Relative counts force mental arithmetic at the end of a tired day and
the user has to translate "T-8" back to a real date before they can
plan. You MAY append a relative count in parentheses after the
absolute date when the event is > 14 days out
("6月29日 09:30 (T+25)"). Never use "soon", "shortly", "近期",
"尽快" — those are not a trigger.
</absolute_dates>

<prefill_parameters>
`primary_action.agent_prompt` is the task spec the Card Execution
agent runs on confirm. It MUST be runnable WITHOUT a follow-up turn
with the user. Before emitting an agent_prompt, ask: "if I handed
this off to a competent assistant right now, can they finish without
asking me one question?" If not, pull the missing parameters from
the source bundle:
  - Family size / passenger counts → `profile.facts.family`.
  - Recipient email / sender / thread → gmail source `from` / `id`.
  - Calendar event id / time zone   → gcal source `id` / `start`.
  - File names / portal URLs        → gmail body / signal payload.
The agent_prompt may be longer than the title — its job is task
completeness, not brevity. Do not trade away a real parameter for a
shorter line.
</prefill_parameters>

<one_decision_per_card>
Each card surfaces ONE concrete decision. Do not present two parallel
choices ("先转 SWVXX 还是恢复 VOO 定投?", "Option A vs Option B") inside
one card — pick the stronger one and recommend it, push the other into
a `secondary_actions` entry or skip it. The primary_action represents
your single recommendation; if you can't pick, the card isn't ready
and should be dropped into `skipped_plan_items`.
</one_decision_per_card>

<connector_guidance_card_format>
When the plan item has intent_key prefix "connect:<toolkit_slug>", you
are writing a connector-guidance card. The frontend renders these
specially: clicking the primary action opens the OAuth connect flow
directly — it does NOT open a chat thread. Emit the card with:

- intent_key: keep the plan item's slug verbatim (e.g.,
  "connect:google_calendar"). Valid toolkits: gmail, google_calendar,
  slack, github, google_drive, calendly, linkedin, stripe, youtube.
- goal_basket: the basket that best explains WHY this connector helps
  the user (e.g., a calendar nudge tied to work meetings → "work";
  a generic personal calendar → "life").
- title: ≤60 chars, soft and outcome-led. DO NOT start with the
  imperative verb "Connect".
    GOOD: "I could prep your Tuesday review if you connect Calendar"
    BAD : "Connect Google Calendar"
- why_now: one sentence citing the SPECIFIC trigger signal (verbatim
  detail from `sources[]`). For cold-start, write: "You haven't
  connected any data sources yet."
- summary: 2 sentences. (1) the concrete value this connector unlocks
  for THIS user given their context. (2) what data we pull, in plain
  words ("read-only access to your calendar events"). No marketing.
- primary_action:
    label: "Connect <Human Name>"   # e.g., "Connect Calendar"
    type: "confirm"
    agent_prompt: null   # REQUIRED null — frontend intercepts on click
                         # and runs the OAuth flow; chat MUST NOT open.
- secondary_actions: [{"label": "Not now", "type": "snooze",
                       "agent_prompt": null}]
- sources: cite the triggering signal/memory verbatim. For cold-start,
  cite the cold-start fact literally:
    "connections_summary=[] (no data sources connected yet)"
- confidence: 0.7–0.9
- urgency: ≤0.4   # connector guidance is NEVER urgent
- importance: 0.5–0.7

The agent_prompt=null exception only applies to connector-guidance
cards. All other cards still require a runnable agent_prompt on
confirm/modify.
</connector_guidance_card_format>

<output>
`response_format` is `CardsList`. The schema enforces `sources[]`
non-empty per card; the LLM runtime will reject malformed output.
</output>
"""


_EVALUATOR_PROMPT = """You are the evaluator stage of the Pin AI card generator.

<role>
You are the INDEPENDENT critic. You did not write these cards. Your
job is to score each one on 5 dimensions and decide pass/fail. Your
verdict is final — cards you fail will be dropped from the user-facing
batch.
</role>

<scoring_dimensions>
Score each on a 0.0-10.0 scale:

- **relevance**: Does this connect to a real user goal / persona /
  signal evidenced in the card's `sources`?
  0-3 no clear connection · 4-6 loose · 7-8 clear · 9-10 hits a stated goal

- **actionability**: Can the user act in <2 minutes? Is the
  primary_action a concrete verb+object?
  0-3 informational only · 4-6 vague · 7-8 specific · 9-10 one-click

- **why_now_clarity**: Is the trigger time-bounded and verifiable
  against `sources`?
  0-3 anytime · 4-6 vague urgency · 7-8 specific · 9-10 perishable window

- **novelty**: Is this NEW info for the user, or a restatement of
  what they already know? (You don't have access to cards_recent
  here — judge novelty by "would a thoughtful user say 'I knew that'?")
  0-3 stale / known · 4-6 new angle on known · 7-8 genuinely new · 9-10 surprising

- **decision_compression**: How much thinking does this save the user?
  0-3 must research · 4-6 some context · 7-8 most thinking done · 9-10 complete package

- **pattern_grounding**: When the card claims a `pattern_id`, every
  signal type required by that pattern (find the entry in the provided
  matched patterns JSON and inspect its `evidence` keys) must appear in
  `sources[]` with a verbatim citation. The combination of signals must
  also be visible in the card copy — not just listed in `sources[]`. When
  the pattern includes
  `cardSkeleton.title_strategy`, judge whether the title follows its
  formula/example style: concrete fact / number / time + human stake +
  immediate action. Score 0 = the card claims a pattern but
  fails to cite the required combination; 10 = full skeleton compliance.
  Score 0 (with `pattern_grounding_ok = false`) when the card has no
  `pattern_id` so this dimension doesn't pull the overall down — set
  `pattern_id = null` in the evaluation row and exclude this dim from
  the overall average in that case.

overall = average of the dimensions you actually scored (5 when
pattern_grounding doesn't apply, 6 when it does).
pass = overall >= 5.0 AND no grounding violation (every cited id must
look plausibly extractable from a real data source — flag fabrications
by failing) AND (pattern_id is null OR pattern_grounding >= 5).
Set `pattern_grounding_ok = true` when pattern_id is set AND
pattern_grounding >= 5.
</scoring_dimensions>

<calibration>
- The card-generator is a sibling agent that wants its work to ship.
  Resist generosity. A card you naturally rate 8.5 is probably 7.5.
- Score by the EVIDENCE in `sources`, not by how well-written the
  prose is. A beautifully written card with weak sources fails on
  relevance / why_now_clarity.
- If two cards address the same underlying decision (different angles
  of the same intent), flag the weaker as a duplicate by failing
  novelty (give 3-4) and noting it in `feedback`.
- For ambient transcript cards, fail grounding when the card attributes
  non-self speaker text to the user or treats another speaker's words as
  the user's stated intent.
</calibration>

<output>
`response_format` is `EvalReport` — one CardEvaluation per card
provided, plus a `batch_feedback` string covering cross-card
observations (basket distribution, weakest card, sourcing patterns).
For each `feedback`, write a concise 2-4 sentence rationale. Do not
write long dimension-by-dimension essays.
"""


_FINAL_SELECTION_PROMPT = """You are the final editor of a Pin AI card batch.

<role>
You do not write new cards. You select and order the best user-facing
cards from already generated candidates and their evaluator scores.
</role>

<rules>
- Prefer `pass=true` cards. Do not choose failed cards when there are
  enough passing cards to fill the batch.
- Remove duplicate underlying decisions even if titles differ.
- Prefer concrete, time-bounded, actionable cards over generic updates.
- Keep useful basket diversity, but never use diversity to include a
  weak or poorly grounded card.
- Use only the provided card/evaluation summaries. Do not ask for
  phase1, source bundles, or tools.
</rules>

<output>
Return FinalSelection: selectedIntentKeys in final display order,
rejectedIntentKeys for candidates you intentionally drop, and one short
notes paragraph.
</output>
"""


def _lang_clause(output_language: str) -> str:
    if output_language in ("zh-Hans", "zh"):
        return "Use Simplified Chinese for all user-visible text fields"
    return "Use English for all user-visible text fields"


def _stage_config(*, run_id: str, user_id: int, stage: str) -> dict[str, Any]:
    return {
        "metadata": {
            "pinai_run_id": run_id,
            "pinai_user_id": str(user_id),
            "pinai_agent": "generator",
            "pinai_generator_stage": stage,
        },
        "tags": ["pinai", "generator", f"pinai_run:{run_id}", f"stage:{stage}"],
        "recursion_limit": 50,
    }


def _dump_model(value: Any) -> str:
    if hasattr(value, "model_dump"):
        return json.dumps(value.model_dump(by_alias=False), ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False)


def _truncate(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def _compact_payload(value: Any, *, limit: int = _MAX_SOURCE_PAYLOAD_CHARS) -> str:
    return _truncate(value, limit)


def _first_text(row: dict[str, Any], keys: tuple[str, ...], default: str = "") -> str:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            text = str(value).strip()
        else:
            text = _truncate(value, _MAX_SOURCE_SNIPPET_CHARS)
        if text:
            return text
    return default


def _source_id(row: dict[str, Any], source_type: str, idx: int) -> str:
    for key in ("id", "message_id", "messageId", "thread_id", "threadId", "event_id", "eventId"):
        value = row.get(key)
        if value:
            return str(value)
    return f"{source_type}:{idx}"


def _citation_for(source_type: str, source_id: str, title: str, snippet: str) -> str:
    title_or_snippet = title or snippet
    if source_type == "signal":
        return f"signal id={source_id}, title={_truncate(title_or_snippet, 120)}"
    if source_type == "memory":
        return f"memory id={source_id}, text={_truncate(snippet or title, 160)}"
    if source_type == "gmail":
        return f"gmail message id={source_id}, subject={_truncate(title_or_snippet, 160)}"
    if source_type == "gcal":
        return f"gcal event id={source_id}, title={_truncate(title_or_snippet, 160)}"
    if source_type == "world":
        return f"world id={source_id}, title={_truncate(title_or_snippet, 160)}"
    if source_type == "profile":
        return f"profile id={source_id}, summary={_truncate(snippet or title, 160)}"
    if source_type == "goal":
        return f"goal id={source_id}, title={_truncate(title_or_snippet, 160)}"
    if source_type == "preference":
        return f"preference id={source_id}, statement={_truncate(snippet or title, 160)}"
    return f"{source_type} id={source_id}, text={_truncate(snippet or title, 160)}"


def _source_record(source_type: str, row: dict[str, Any], idx: int) -> dict[str, Any]:
    source_id = _source_id(row, source_type, idx)
    title = _first_text(
        row,
        ("title", "subject", "name", "summary", "statement", "text", "snippet"),
        default=source_id,
    )
    snippet = _first_text(
        row,
        ("snippet", "summary", "text", "body", "description", "content", "statement"),
        default=title,
    )
    timestamp = _first_text(
        row,
        ("occurred_at", "created_at", "received_at", "start", "ts", "timestamp", "time"),
    )
    salience_value = row.get("salience")
    payload = row.get("payload")
    if isinstance(payload, dict) and salience_value is None:
        salience_value = payload.get("salience")
    try:
        salience = float(salience_value) if salience_value is not None else 0.0
    except (TypeError, ValueError):
        salience = 0.0
    return {
        "id": source_id,
        "source_type": source_type,
        "title": _truncate(title, 180),
        "snippet": _truncate(snippet, _MAX_SOURCE_SNIPPET_CHARS),
        "timestamp": timestamp,
        "salience": salience,
        "citation": _citation_for(source_type, source_id, title, snippet),
        "payload": _compact_payload(row),
    }


def _append_list_sources(
    records: list[dict[str, Any]],
    *,
    source_type: str,
    value: Any,
) -> None:
    if not isinstance(value, list):
        return
    for idx, item in enumerate(value):
        if isinstance(item, dict):
            records.append(_source_record(source_type, item, idx))


def _build_source_index(phase1: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    profile = phase1.get("profile")
    if isinstance(profile, dict) and profile:
        records.append(
            _source_record(
                "profile",
                {
                    "id": "primary",
                    "title": profile.get("display_name") or "profile",
                    "summary": profile.get("summary") or profile.get("facts") or profile,
                },
                0,
            )
        )
    _append_list_sources(records, source_type="memory", value=phase1.get("memory"))
    _append_list_sources(records, source_type="goal", value=phase1.get("goals"))
    _append_list_sources(records, source_type="signal", value=phase1.get("signals"))
    _append_list_sources(records, source_type="gmail", value=phase1.get("gmail"))
    _append_list_sources(records, source_type="gcal", value=phase1.get("gcal"))
    _append_list_sources(records, source_type="world", value=phase1.get("world"))
    _append_list_sources(records, source_type="preference", value=phase1.get("preferences"))
    connected_raw = phase1.get("connected_raw")
    if isinstance(connected_raw, dict):
        for source_type, rows in connected_raw.items():
            _append_list_sources(records, source_type=str(source_type), value=rows)

    by_id: dict[str, dict[str, Any]] = {}
    for record in records:
        key = str(record["id"])
        existing = by_id.get(key)
        if existing is None or float(record.get("salience") or 0) > float(
            existing.get("salience") or 0
        ):
            by_id[key] = record
    return sorted(
        by_id.values(),
        key=lambda item: (float(item.get("salience") or 0), str(item.get("timestamp") or "")),
        reverse=True,
    )


def _compact_list(value: Any, limit: int, *, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    compacted: list[dict[str, Any]] = []
    for item in value[:limit]:
        if not isinstance(item, dict):
            continue
        compacted.append({key: item.get(key) for key in keys if key in item})
    return compacted


def _compact_recent_cards(value: Any, limit: int = 12) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    compacted: list[dict[str, Any]] = []
    for item in value[:limit]:
        if not isinstance(item, dict):
            continue
        sources = item.get("sources")
        compacted.append(
            {
                "id": item.get("id"),
                "intentKey": item.get("intentKey") or item.get("intent_key"),
                "title": _truncate(item.get("title") or "", 160),
                "goalBasket": item.get("goalBasket") or item.get("goal_basket"),
                "whyNow": _truncate(item.get("whyNow") or item.get("why_now") or "", 160),
                "summary": _truncate(item.get("summary") or "", 260),
                "latestOutcome": item.get("latestOutcome") or item.get("latest_outcome"),
                "outcomeAt": item.get("outcomeAt") or item.get("outcome_at"),
                "sources": [_truncate(source, 140) for source in sources[:2]]
                if isinstance(sources, list)
                else [],
            }
        )
    return compacted


# Composio's canonical slug ↔ the underscore-form slug the planner /
# main-chat prompts emit (`connect:<slug>`, `[connect:<slug>]`). Only the
# two Google connectors actually differ; everything else round-trips.
# Keep this aligned with the prompt whitelist in _PLANNER_PROMPT /
# _CARD_GENERATOR_PROMPT / main_chat.py and with the frontend ALIASES
# table in proactive-ai-frontend/src/lib/toolkit-icons.ts.
_COMPOSIO_TO_PROMPT_SLUG: dict[str, str] = {
    "googlecalendar": "google_calendar",
    "googledrive": "google_drive",
}

_PROMPT_CONNECTOR_SLUG_ALIASES: dict[str, str] = {
    "gcal": "google_calendar",
    "googlecalendar": "google_calendar",
    "gdrive": "google_drive",
    "googledrive": "google_drive",
}

_CONNECT_INTENT_PREFIX = "connect:"
_CONNECTOR_REJECTION_OUTCOMES = {
    "dismiss",
    "snooze",
    "negative",
    "thumbs_down",
}


def _prompt_slug_for_toolkit(composio_slug: str | None) -> str | None:
    if not composio_slug:
        return None
    return _COMPOSIO_TO_PROMPT_SLUG.get(composio_slug, composio_slug)


def _normalize_connector_prompt_slug(slug: str | None) -> str | None:
    if not slug:
        return None
    value = slug.strip().lower()
    if not value:
        return None
    return _PROMPT_CONNECTOR_SLUG_ALIASES.get(value, value)


def _connector_slug_from_intent_key(intent_key: str | None) -> str | None:
    if not intent_key:
        return None
    value = intent_key.strip().lower()
    if not value.startswith(_CONNECT_INTENT_PREFIX):
        return None
    return _normalize_connector_prompt_slug(value[len(_CONNECT_INTENT_PREFIX) :])


def _connector_intent_key(intent_key: str | None) -> str | None:
    slug = _connector_slug_from_intent_key(intent_key)
    return f"{_CONNECT_INTENT_PREFIX}{slug}" if slug else None


def _feedback_outcome(row: dict[str, Any]) -> str:
    return str(
        row.get("action")
        or row.get("outcome")
        or row.get("latestOutcome")
        or row.get("kind")
        or ""
    ).strip().lower()


def _filter_connector_guidance_plan_items(
    items: list[Any],
    *,
    compact_phase1: dict[str, Any],
    existing_intent_keys: list[str] | None = None,
) -> list[Any]:
    """Enforce connector-card product limits outside the LLM prompt."""
    active_toolkits: set[str] = set()
    for conn in compact_phase1.get("connections_summary") or []:
        if not isinstance(conn, dict):
            continue
        status = str(conn.get("status") or "ACTIVE").upper()
        if status != "ACTIVE":
            continue
        slug = _normalize_connector_prompt_slug(str(conn.get("toolkit") or ""))
        if slug:
            active_toolkits.add(slug)

    recent_connector_intents = {
        normalized
        for card in compact_phase1.get("cards_recent") or []
        if isinstance(card, dict)
        for normalized in [
            _connector_intent_key(
                card.get("intentKey") or card.get("intent_key")
            )
        ]
        if normalized
    }
    rejected_connector_intents = {
        normalized
        for row in compact_phase1.get("feedback") or []
        if isinstance(row, dict)
        and _feedback_outcome(row) in _CONNECTOR_REJECTION_OUTCOMES
        for normalized in [
            _connector_intent_key(
                row.get("intentKey") or row.get("intent_key")
            )
        ]
        if normalized
    }
    connector_count = sum(
        1
        for key in existing_intent_keys or []
        if _connector_slug_from_intent_key(str(key))
    )

    filtered: list[Any] = []
    for item in items:
        intent_key = str(getattr(item, "intent_key", "") or "")
        slug = _connector_slug_from_intent_key(intent_key)
        if not slug:
            filtered.append(item)
            continue

        normalized_intent = f"{_CONNECT_INTENT_PREFIX}{slug}"
        if (
            slug in active_toolkits
            or normalized_intent in recent_connector_intents
            or normalized_intent in rejected_connector_intents
            or connector_count >= 1
        ):
            continue
        filtered.append(item)
        connector_count += 1
    return filtered


def _compact_phase1_for_planner(
    phase1: dict[str, Any],
    source_index: list[dict[str, Any]],
) -> dict[str, Any]:
    raw_profile = phase1.get("profile")
    profile: dict[str, Any] = raw_profile if isinstance(raw_profile, dict) else {}
    return {
        "profile": {
            "display_name": profile.get("display_name"),
            "summary": _truncate(profile.get("summary") or "", 600),
            "facts": _truncate(profile.get("facts") or {}, 1000),
        },
        "sources": [
            {
                "id": item["id"],
                "source_type": item["source_type"],
                "title": item["title"],
                "snippet": item["snippet"],
                "timestamp": item["timestamp"],
                "salience": item["salience"],
                "citation": item["citation"],
            }
            for item in source_index[:_MAX_PLANNER_SOURCES]
        ],
        "cards_recent": _compact_recent_cards(phase1.get("cards_recent")),
        "goals": _compact_list(
            phase1.get("goals"),
            20,
            keys=("id", "key", "title", "priority", "status", "summary"),
        ),
        "feedback": _compact_list(
            phase1.get("feedback"),
            30,
            keys=("cardId", "intentKey", "outcome", "text", "createdAt", "created_at"),
        ),
        "preferences": _compact_list(
            phase1.get("preferences"),
            30,
            keys=("id", "statement", "scope", "polarity", "durability", "expires_at", "weight"),
        ),
        # Compact view of Composio connections so the planner can decide
        # whether to emit a connector-guidance card (intent_key="connect:<slug>").
        # The full `connections` and `connected_raw` blobs are still in phase1
        # for downstream stages; planner only needs toolkit + status + label.
        #
        # `toolkit` is normalized to the prompt-friendly underscore form
        # (`google_calendar`, `google_drive`) so the planner can do literal
        # string dedup between `connections_summary[].toolkit` and the
        # `connect:<slug>` keys it's instructed to emit. Without this the
        # LLM sees Composio's `googlecalendar` but is told to write
        # `connect:google_calendar`, and dedup becomes a fuzzy mental match
        # that misfires on the two Google connectors.
        "connections_summary": [
            entry
            for entry in (
                {
                    "toolkit": _prompt_slug_for_toolkit(_connection_toolkit(conn)),
                    "status": conn.get("status"),
                    "label": conn.get("label"),
                }
                for conn in (phase1.get("connections") or [])
                if isinstance(conn, dict)
            )
            if entry["toolkit"]
        ],
    }


def _compact_phase1_for_topup(compact_phase1: dict[str, Any]) -> dict[str, Any]:
    topup = dict(compact_phase1)
    sources = topup.get("sources")
    if isinstance(sources, list):
        topup["sources"] = sources[:40]
    cards_recent = topup.get("cards_recent")
    if isinstance(cards_recent, list):
        topup["cards_recent"] = cards_recent[:12]
    return topup


def _tokenize(value: str) -> set[str]:
    return {part for part in re.split(r"[^A-Za-z0-9_\-\u4e00-\u9fff]+", value.lower()) if len(part) > 2}


def _source_score_for_plan(plan_text: str, source: dict[str, Any]) -> float:
    plan_tokens = _tokenize(plan_text)
    source_tokens = _tokenize(
        " ".join(
            str(source.get(key) or "")
            for key in ("id", "source_type", "title", "snippet", "citation")
        )
    )
    overlap = len(plan_tokens & source_tokens)
    return overlap + float(source.get("salience") or 0)


def _collect_pattern_evidence_ids(
    *,
    plan_item: Any,
    matched_patterns: list[dict[str, Any]],
) -> set[str]:
    pattern_id = getattr(plan_item, "pattern_id", None)
    if not pattern_id:
        return set()
    evidence_ids: set[str] = set()
    for pattern in matched_patterns:
        if str(pattern.get("patternId") or pattern.get("pattern_id")) != pattern_id:
            continue
        stack = [pattern.get("evidence")]
        while stack:
            value = stack.pop()
            if isinstance(value, dict):
                stack.extend(value.values())
            elif isinstance(value, list):
                stack.extend(value)
            elif value:
                evidence_ids.add(str(value))
    return evidence_ids


def _source_bundle_for_plan_item(
    *,
    plan_item: Any,
    source_index: list[dict[str, Any]],
    compact_phase1: dict[str, Any],
    matched_patterns: list[dict[str, Any]],
) -> dict[str, Any]:
    primary_ids = {str(item) for item in getattr(plan_item, "primary_source_ids", []) or []}
    evidence_ids = _collect_pattern_evidence_ids(
        plan_item=plan_item,
        matched_patterns=matched_patterns,
    )
    selected_ids = primary_ids | evidence_ids
    by_id = {str(item["id"]): item for item in source_index}
    selected = [by_id[source_id] for source_id in selected_ids if source_id in by_id]

    plan_text = " ".join(
        str(getattr(plan_item, attr, "") or "")
        for attr in ("intent_key", "goal_basket", "decision", "why_now_trigger", "pattern_id")
    )
    ranked = sorted(
        (item for item in source_index if item not in selected),
        key=lambda item: _source_score_for_plan(plan_text, item),
        reverse=True,
    )
    for item in ranked:
        if len(selected) >= _MAX_BUNDLE_SOURCES:
            break
        if _source_score_for_plan(plan_text, item) <= 0 and selected:
            continue
        selected.append(item)

    return {
        "plan_item": plan_item.model_dump(by_alias=False)
        if hasattr(plan_item, "model_dump")
        else plan_item,
        "sources": selected[:_MAX_BUNDLE_SOURCES],
        "profile": compact_phase1.get("profile") or {},
        "preferences": compact_phase1.get("preferences") or [],
        "cards_recent": compact_phase1.get("cards_recent") or [],
    }


def _card_writer_content(
    *,
    plan_item: Any,
    source_bundle: dict[str, Any],
    current_date: str,
    output_language: str,
) -> str:
    return (
        f"Today is {current_date}. {_lang_clause(output_language)}.\n"
        "Write exactly one GeneratedCard for this plan item. Use only the "
        "provided source bundle. Copy citation strings verbatim into sources[].\n"
        f"<plan_item_json>{_dump_model(plan_item)}</plan_item_json>\n"
        f"<source_bundle_json>{json.dumps(source_bundle, ensure_ascii=False)}</source_bundle_json>"
    )


def _evaluator_content(
    *,
    card: Any,
    source_bundle: dict[str, Any],
    current_date: str,
) -> str:
    return (
        f"Today is {current_date}.\n"
        "Evaluate exactly one card against its source bundle. Use only the "
        "provided bundle for grounding checks.\n"
        f"<card_json>{_dump_model(card)}</card_json>\n"
        f"<source_bundle_json>{json.dumps(source_bundle, ensure_ascii=False)}</source_bundle_json>"
    )


def _rank_cards(
    *,
    cards: list[Any],
    evaluations: list[Any],
    limit: int,
) -> list[Any]:
    eval_by_intent = {getattr(ev, "intent_key", ""): ev for ev in evaluations}
    best_by_intent: dict[str, Any] = {}
    for card in cards:
        intent = getattr(card, "intent_key", "")
        existing = best_by_intent.get(intent)
        ev = eval_by_intent.get(intent)
        existing_ev = eval_by_intent.get(getattr(existing, "intent_key", "")) if existing else None
        score = float(getattr(ev, "overall", 0.0) or 0.0)
        existing_score = float(getattr(existing_ev, "overall", 0.0) or 0.0)
        if existing is None or score > existing_score:
            best_by_intent[intent] = card

    ranked = sorted(
        best_by_intent.values(),
        key=lambda card: (
            bool(getattr(eval_by_intent.get(getattr(card, "intent_key", "")), "pass_", False)),
            float(getattr(eval_by_intent.get(getattr(card, "intent_key", "")), "overall", 0.0) or 0.0),
            float(getattr(card, "importance", 0.0) or 0.0),
            float(getattr(card, "urgency", 0.0) or 0.0),
        ),
        reverse=True,
    )
    selected: list[Any] = []
    seen_baskets: set[str] = set()
    for card in ranked:
        basket = str(getattr(card, "goal_basket", ""))
        if basket in seen_baskets and len(selected) < min(limit, 3):
            continue
        selected.append(card)
        seen_baskets.add(basket)
        if len(selected) >= limit:
            return selected
    for card in ranked:
        if card not in selected:
            selected.append(card)
        if len(selected) >= limit:
            break
    return selected


def _evaluation_by_intent(evaluations: list[Any]) -> dict[str, Any]:
    return {str(getattr(ev, "intent_key", "")): ev for ev in evaluations}


def _passing_evaluation_count(evaluations: list[Any]) -> int:
    return sum(1 for ev in evaluations if bool(getattr(ev, "pass_", False)))


def _usable_unique_card_count(cards: list[Any], evaluations: list[Any]) -> int:
    passing_intents: set[str] = set()
    for ev in evaluations:
        intent = str(getattr(ev, "intent_key", "") or "")
        if intent and bool(getattr(ev, "pass_", False)):
            passing_intents.add(intent)

    usable_intents: set[str] = set()
    for card in cards:
        intent = str(getattr(card, "intent_key", "") or "")
        if intent in passing_intents:
            usable_intents.add(intent)
    return len(usable_intents)


def _candidate_summary(card: Any, evaluation: Any | None) -> dict[str, Any]:
    primary_action = getattr(card, "primary_action", None)
    return {
        "intent_key": getattr(card, "intent_key", ""),
        "goal_basket": getattr(card, "goal_basket", ""),
        "title": _truncate(getattr(card, "title", ""), 140),
        "why_now": _truncate(getattr(card, "why_now", ""), 90),
        "summary": _truncate(getattr(card, "summary", ""), 90),
        "primary_action": getattr(primary_action, "label", ""),
        "urgency": getattr(card, "urgency", 0.0),
        "importance": getattr(card, "importance", 0.0),
        "sources": [_truncate(source, 70) for source in getattr(card, "sources", [])[:1]],
        "evaluation": {
            "pass": bool(getattr(evaluation, "pass_", False)),
            "overall": getattr(evaluation, "overall", None),
            "novelty": getattr(evaluation, "novelty", None),
            "feedback": _truncate(getattr(evaluation, "feedback", ""), 90),
        },
    }


def _existing_card_context(
    *,
    compact_phase1: dict[str, Any],
    generated_cards: list[Any],
) -> dict[str, Any]:
    return {
        "recent_cards": (compact_phase1.get("cards_recent") or [])[:12],
        "current_candidates": [
            {
                "intent_key": getattr(card, "intent_key", ""),
                "goal_basket": getattr(card, "goal_basket", ""),
                "title": _truncate(getattr(card, "title", ""), 160),
                "why_now": _truncate(getattr(card, "why_now", ""), 160),
                "summary": _truncate(getattr(card, "summary", ""), 260),
                "sources": [
                    _truncate(source, 140)
                    for source in getattr(card, "sources", [])[:2]
                ],
            }
            for card in generated_cards
        ],
    }


def _final_selection_content(
    *,
    cards: list[Any],
    evaluations: list[Any],
    limit: int,
    current_date: str,
) -> str:
    eval_by_intent = _evaluation_by_intent(evaluations)
    summaries = [
        _candidate_summary(card, eval_by_intent.get(str(getattr(card, "intent_key", ""))))
        for card in cards
    ]
    return (
        f"Today is {current_date}.\n"
        f"Select up to {limit} final cards from these candidates. "
        "Return only intent keys that appear in the summaries.\n"
        f"<card_eval_summaries_json>{json.dumps(summaries, ensure_ascii=False)}</card_eval_summaries_json>"
    )


def _is_usable_for_final(evaluation: Any | None, *, has_enough_passing: bool) -> bool:
    if evaluation is None:
        return False
    if bool(getattr(evaluation, "pass_", False)):
        return True
    return not has_enough_passing and float(getattr(evaluation, "overall", 0.0) or 0.0) >= 5.0


def _apply_final_selection(
    *,
    cards: list[Any],
    evaluations: list[Any],
    selection: FinalSelection,
    limit: int,
) -> list[Any]:
    cards_by_intent = {str(getattr(card, "intent_key", "")): card for card in cards}
    eval_by_intent = _evaluation_by_intent(evaluations)
    passing_count = sum(1 for ev in evaluations if bool(getattr(ev, "pass_", False)))
    has_enough_passing = passing_count >= limit
    rejected = {str(key) for key in selection.rejected_intent_keys}

    selected: list[Any] = []
    selected_intents: set[str] = set()
    for intent in selection.selected_intent_keys:
        key = str(intent)
        card = cards_by_intent.get(key)
        if card is None or key in selected_intents:
            continue
        if not _is_usable_for_final(eval_by_intent.get(key), has_enough_passing=has_enough_passing):
            continue
        selected.append(card)
        selected_intents.add(key)
        if len(selected) >= limit:
            return selected

    for card in _rank_cards(cards=cards, evaluations=evaluations, limit=len(cards)):
        key = str(getattr(card, "intent_key", ""))
        if key in selected_intents or key in rejected:
            continue
        selected.append(card)
        selected_intents.add(key)
        if len(selected) >= limit:
            return selected

    for card in _rank_cards(cards=cards, evaluations=evaluations, limit=len(cards)):
        key = str(getattr(card, "intent_key", ""))
        if key in selected_intents:
            continue
        selected.append(card)
        selected_intents.add(key)
        if len(selected) >= limit:
            break
    return selected


async def _invoke_stage(
    agent: Any,
    *,
    content: str,
    run_id: str,
    user_id: int,
    stage: str,
) -> dict[str, Any]:
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": content}]},
        config=_stage_config(run_id=run_id, user_id=user_id, stage=stage),
    )
    if not isinstance(result, dict):
        msg = f"generator stage {stage} returned {type(result).__name__}, expected dict. run_id={run_id}."
        raise ValueError(msg)
    return result


async def _invoke_structured_stage(
    model: Any,
    schema: type[Any],
    *,
    system: str,
    content: str,
    run_id: str,
    user_id: int,
    stage: str,
) -> Any:
    runnable = model.with_structured_output(schema)
    last_exc: BaseException | None = None
    for attempt in range(_STRUCTURED_STAGE_MAX_ATTEMPTS):
        try:
            return await runnable.ainvoke(
                [("system", system), ("human", content)],
                config=_stage_config(run_id=run_id, user_id=user_id, stage=stage),
            )
        except Exception as exc:
            # Broad catch is intentional: LiteLLM/transport blips, worker
            # restarts, and provider 429/5xx all surface as different types
            # here and are all worth one more try before failing the stage.
            last_exc = exc
            logger.warning(
                "structured stage retry run_id=%s stage=%s attempt=%d/%d error=%r",
                run_id,
                stage,
                attempt + 1,
                _STRUCTURED_STAGE_MAX_ATTEMPTS,
                exc,
            )
            if attempt + 1 < _STRUCTURED_STAGE_MAX_ATTEMPTS:
                await asyncio.sleep(_STRUCTURED_STAGE_RETRY_BACKOFF_S * (attempt + 1))
    assert last_exc is not None
    raise last_exc


async def run_generator(
    *,
    virtual_key: str,
    current_date: str,
    user_id: int,
    run_id: str,
    run_jwt: str,
    cards_to_generate: int = 8,
    output_language: str = "en",
    user_message: str = "Generate Intent Cards now.",
    matched_patterns: list[dict[str, Any]] | None = None,
    context_since: datetime | None = None,
    context_until: datetime | None = None,
) -> GeneratorOutput:
    """One-shot generator run. Returns the validated GeneratorOutput.

    The deterministic context builder reads web's agent APIs with the
    per-run JWT, then Python passes compact JSON inline to the structured
    planner / card / evaluator calls.

    Caller responsibilities:
      - current_date in YYYY-MM-DD.
      - user_id / run_id / run_jwt for web agent API reads.
      - The returned GeneratorOutput is already validated (Pydantic);
        no further parse / shape check needed.
    """
    session_key = f"gen-{run_id}"
    try:
        with run_context(
            user_id=user_id,
            run_id=run_id,
            run_jwt=run_jwt,
            virtual_key=virtual_key,
            session_key=session_key,
        ):
            structured_model = make_chat_model(
                virtual_key=virtual_key,
                model="claude-sonnet-4-6",
                temperature=0.2,
                enable_thinking=False,
            )

            # Fixed pipeline: the old root orchestrator could loop over
            # `task()` calls for hundreds of LLM turns. Context collection
            # is deterministic HTTP, then the LLM stages run once from
            # Python so user-facing generation has a predictable envelope.
            phase1 = await build_generation_context(
                now=context_until or datetime.now(UTC),
                context_since=context_since,
                context_until=context_until,
            )
            phase1_json = json.dumps(phase1, default=str, ensure_ascii=False)
            phase1_read = SimpleNamespace(
                error=None,
                file_data={"content": phase1_json},
            )
            logger.info(
                "generator stage ok run_id=%s stage=context_builder bytes=%d",
                run_id,
                len(phase1_json),
            )

            if phase1_read.error or phase1_read.file_data is None:
                result = {
                    "structured_response": GeneratorOutput(
                        reasoning="Fixed pipeline stopped because phase1.json could not be read.",
                        cards=[],
                        evaluations=[],
                        batch_feedback=phase1_read.error or "phase1.json missing",
                    )
                }
            else:
                target_cards = max(1, min(cards_to_generate, 8))
                candidate_count = min(max(target_cards + 4, target_cards), 12)
                phase1_json = phase1_read.file_data["content"]
                try:
                    phase1 = json.loads(phase1_json)
                except json.JSONDecodeError as e:
                    msg = f"phase1.json is not valid JSON. run_id={run_id}."
                    raise ValueError(msg) from e
                if not isinstance(phase1, dict):
                    msg = f"phase1.json root must be object. run_id={run_id}."
                    raise ValueError(msg)

                source_index = _build_source_index(phase1)
                compact_phase1 = _compact_phase1_for_planner(phase1, source_index)
                compact_phase1_json = json.dumps(compact_phase1, ensure_ascii=False)
                topup_phase1_json = json.dumps(
                    _compact_phase1_for_topup(compact_phase1),
                    ensure_ascii=False,
                )
                matched_json = json.dumps(matched_patterns or [], ensure_ascii=False)

                plan = await _invoke_structured_stage(
                    structured_model,
                    PlanOutput,
                    system=(
                        _PLANNER_PROMPT.format(cards_to_generate=candidate_count)
                        + "\n\nDIRECT MODE: phase1.json and matched_patterns.json are provided "
                        "in the user message. Do not call tools or read_file; use only the "
                        "provided compact JSON and return one PlanOutput. Plan up to "
                        f"{candidate_count} candidates so the final ranker can keep "
                        f"{target_cards} high-quality cards."
                    ),
                    content=(
                        f"Today is {current_date}. {_lang_clause(output_language)}.\n"
                        f"Target {target_cards} final cards; plan up to {candidate_count} candidates.\n"
                        f"<matched_patterns_json>{matched_json}</matched_patterns_json>\n"
                        f"<phase1_json>{compact_phase1_json}</phase1_json>"
                    ),
                    run_id=run_id,
                    user_id=user_id,
                    stage="planner",
                )
                if not isinstance(plan, PlanOutput):
                    msg = (
                        f"planner did not return PlanOutput; "
                        f"got {type(plan).__name__}. run_id={run_id}."
                    )
                    raise ValueError(msg)
                logger.info(
                    "generator stage ok run_id=%s stage=planner items=%d",
                    run_id,
                    len(plan.plan),
                )

                plan_items = _filter_connector_guidance_plan_items(
                    plan.plan[:candidate_count],
                    compact_phase1=compact_phase1,
                )
                if not plan_items:
                    result = {
                        "structured_response": GeneratorOutput(
                            reasoning="Fixed pipeline stopped after planner returned no grounded plan.",
                            cards=[],
                            evaluations=[],
                            batch_feedback=plan.notes or "planner returned no grounded plan",
                        )
                    }
                else:
                    writer_sem = asyncio.Semaphore(_CARD_STAGE_CONCURRENCY)
                    source_bundles: dict[str, dict[str, Any]] = {}

                    async def _write_one_card(
                        idx: int,
                        item: Any,
                        *,
                        stage_prefix: str,
                    ) -> list[Any]:
                        async with writer_sem:
                            bundle = _source_bundle_for_plan_item(
                                plan_item=item,
                                source_index=source_index,
                                compact_phase1=compact_phase1,
                                matched_patterns=matched_patterns or [],
                            )
                            source_bundles[getattr(item, "intent_key", f"plan-{idx}")] = bundle
                            cards_list = await _invoke_structured_stage(
                                structured_model,
                                CardsList,
                                system=(
                                    # .replace, not .format: the prompt body is
                                    # full of literal JSON examples ({"label": ...})
                                    # that str.format() parses as fields and dies
                                    # on (KeyError: '"label"'). Only one real
                                    # placeholder, so a sentinel replace is safe.
                                    _CARD_GENERATOR_PROMPT.replace(
                                        "{lang_clause}", _lang_clause(output_language)
                                    )
                                    + "\n\nDIRECT MODE: a single PlanItem and source_bundle_json "
                                    "are provided in the user message. Do not call tools or "
                                    "read_file; use only the provided bundle and return one "
                                    "CardsList with exactly one card when grounded."
                                ),
                                content=_card_writer_content(
                                    plan_item=item,
                                    source_bundle=bundle,
                                    current_date=current_date,
                                    output_language=output_language,
                                ),
                                run_id=run_id,
                                user_id=user_id,
                                stage=f"{stage_prefix}_{idx}",
                            )
                            if not isinstance(cards_list, CardsList):
                                msg = (
                                    f"card-generator did not return CardsList; "
                                    f"got {type(cards_list).__name__}. run_id={run_id}."
                                )
                                raise ValueError(msg)
                            cards = list(cards_list.cards[:1])
                            for card in cards:
                                source_bundles[getattr(card, "intent_key", f"card-{idx}")] = bundle
                            return cards

                    async def _write_plan_items(
                        items: list[Any],
                        *,
                        stage_prefix: str,
                    ) -> list[Any]:
                        card_results = await asyncio.gather(
                            *(
                                _write_one_card(idx, item, stage_prefix=stage_prefix)
                                for idx, item in enumerate(items)
                            ),
                            return_exceptions=True,
                        )
                        stage_cards: list[Any] = []
                        failures: list[BaseException] = []
                        for idx, item_result in enumerate(card_results):
                            if isinstance(item_result, BaseException):
                                failures.append(item_result)
                                logger.warning(
                                    "generator card stage failed run_id=%s stage=%s idx=%d error=%r",
                                    run_id,
                                    stage_prefix,
                                    idx,
                                    item_result,
                                )
                                continue
                            stage_cards.extend(item_result)
                        if not stage_cards and failures:
                            # Every writer failed. Surface the real cause instead of
                            # returning an empty batch — downstream that collapses to
                            # an opaque "generator returned no cards" 502 and the true
                            # exception only ever lands in chat-process logs.
                            raise RuntimeError(
                                f"all {len(failures)} card writers failed "
                                f"run_id={run_id} stage={stage_prefix}; "
                                f"first error: {failures[0]!r}"
                            ) from failures[0]
                        logger.info(
                            "generator stage ok run_id=%s stage=%s cards=%d failed=%d",
                            run_id,
                            stage_prefix,
                            len(stage_cards),
                            len(failures),
                        )
                        return stage_cards

                    generated_cards = await _write_plan_items(
                        plan_items,
                        stage_prefix="card_generator",
                    )

                    eval_sem = asyncio.Semaphore(_CARD_STAGE_CONCURRENCY)

                    async def _eval_one_card(
                        idx: int,
                        card: Any,
                        *,
                        stage_prefix: str,
                    ) -> list[Any]:
                        async with eval_sem:
                            bundle = source_bundles.get(getattr(card, "intent_key", ""), {})
                            eval_report = await _invoke_structured_stage(
                                structured_model,
                                EvalReport,
                                system=(
                                    _EVALUATOR_PROMPT
                                    + "\n\nDIRECT MODE: one card and source_bundle_json are "
                                    "provided in the user message. Do not call tools or "
                                    "read_file; use only the provided bundle and return one "
                                    "EvalReport."
                                ),
                                content=_evaluator_content(
                                    card=card,
                                    source_bundle=bundle,
                                    current_date=current_date,
                                ),
                                run_id=run_id,
                                user_id=user_id,
                                stage=f"{stage_prefix}_{idx}",
                            )
                            if not isinstance(eval_report, EvalReport):
                                msg = (
                                    f"evaluator did not return EvalReport; "
                                    f"got {type(eval_report).__name__}. run_id={run_id}."
                                )
                                raise ValueError(msg)
                            return list(eval_report.evaluations)

                    async def _eval_cards(items: list[Any], *, stage_prefix: str) -> list[Any]:
                        eval_results = await asyncio.gather(
                            *(
                                _eval_one_card(idx, card, stage_prefix=stage_prefix)
                                for idx, card in enumerate(items)
                            ),
                            return_exceptions=True,
                        )
                        stage_evals: list[Any] = []
                        for idx, item_result in enumerate(eval_results):
                            if isinstance(item_result, BaseException):
                                logger.warning(
                                    "generator evaluator stage failed run_id=%s stage=%s idx=%d error=%s",
                                    run_id,
                                    stage_prefix,
                                    idx,
                                    item_result,
                                )
                                continue
                            stage_evals.extend(item_result)
                        logger.info(
                            "generator stage ok run_id=%s stage=%s evals=%d",
                            run_id,
                            stage_prefix,
                            len(stage_evals),
                        )
                        return stage_evals

                    if not generated_cards:
                        result = {
                            "structured_response": GeneratorOutput(
                                reasoning=(
                                    "Fixed pipeline stopped after card-generator returned "
                                    "no grounded cards."
                                ),
                                cards=[],
                                evaluations=[],
                                batch_feedback="card-generator returned no grounded cards",
                            )
                        }
                    else:
                        evaluations = await _eval_cards(
                            generated_cards,
                            stage_prefix="evaluator",
                        )
                        for topup_round in range(1, _MAX_TOPUP_ROUNDS + 1):
                            usable_count = _usable_unique_card_count(generated_cards, evaluations)
                            if usable_count >= target_cards:
                                break
                            missing_count = target_cards - usable_count
                            topup_count = min(
                                max(missing_count + (2 if topup_round == 1 else 1), 2),
                                6 if topup_round == 1 else 4,
                            )
                            stage_suffix = "" if topup_round == 1 else str(topup_round)
                            planner_stage = f"topup{stage_suffix}_planner"
                            writer_stage = f"topup{stage_suffix}_card_generator"
                            evaluator_stage = f"topup{stage_suffix}_evaluator"
                            existing_intents = sorted(
                                {
                                    str(getattr(item, "intent_key", ""))
                                    for item in [*plan_items, *generated_cards]
                                    if getattr(item, "intent_key", "")
                                }
                            )
                            try:
                                topup_plan = await _invoke_structured_stage(
                                    structured_model,
                                    PlanOutput,
                                    system=(
                                        _PLANNER_PROMPT.format(cards_to_generate=topup_count)
                                        + "\n\nTOP-UP DIRECT MODE: phase1_json, "
                                        "matched_patterns_json, and existing_intent_keys_json are "
                                        "provided in the user message. Do not call tools or "
                                        "read_file. Return only NEW plan items that are not in "
                                        "existing_intent_keys_json and not semantic duplicates of "
                                        "existing_card_summaries_json. Do not create v2/v3/suffix "
                                        "variants for the same underlying decision. Prefer strong, "
                                        "fresh evidence over basket diversity."
                                    ),
                                    content=(
                                        f"Today is {current_date}. {_lang_clause(output_language)}.\n"
                                        f"Need {missing_count} more passing cards; plan up to "
                                        f"{topup_count} top-up candidates.\n"
                                        f"<existing_intent_keys_json>{json.dumps(existing_intents, ensure_ascii=False)}</existing_intent_keys_json>\n"
                                        "<existing_card_summaries_json>"
                                        f"{json.dumps(_existing_card_context(compact_phase1=compact_phase1, generated_cards=generated_cards), ensure_ascii=False)}"
                                        "</existing_card_summaries_json>\n"
                                        f"<matched_patterns_json>{matched_json}</matched_patterns_json>\n"
                                        f"<phase1_json>{topup_phase1_json}</phase1_json>"
                                    ),
                                    run_id=run_id,
                                    user_id=user_id,
                                    stage=planner_stage,
                                )
                                if not isinstance(topup_plan, PlanOutput):
                                    msg = (
                                        f"top-up planner did not return PlanOutput; "
                                        f"got {type(topup_plan).__name__}. run_id={run_id}."
                                    )
                                    raise ValueError(msg)
                                raw_topup_items = [
                                    item
                                    for item in topup_plan.plan
                                    if str(getattr(item, "intent_key", "")) not in existing_intents
                                ][:topup_count]
                                topup_items = _filter_connector_guidance_plan_items(
                                    raw_topup_items,
                                    compact_phase1=compact_phase1,
                                    existing_intent_keys=existing_intents,
                                )[:topup_count]
                                logger.info(
                                    "generator stage ok run_id=%s stage=%s items=%d",
                                    run_id,
                                    planner_stage,
                                    len(topup_items),
                                )
                                if topup_items:
                                    topup_cards = await _write_plan_items(
                                        topup_items,
                                        stage_prefix=writer_stage,
                                    )
                                    generated_cards.extend(topup_cards)
                                    evaluations.extend(
                                        await _eval_cards(
                                            topup_cards,
                                            stage_prefix=evaluator_stage,
                                        )
                                    )
                            except Exception as e:
                                logger.warning(
                                    "generator top-up stage failed run_id=%s stage=%s error=%s",
                                    run_id,
                                    planner_stage,
                                    e,
                                )
                                break
                        ranked_cards = _rank_cards(
                            cards=generated_cards,
                            evaluations=evaluations,
                            limit=target_cards,
                        )
                        final_selection_notes = ""
                        if ranked_cards and evaluations:
                            try:
                                final_selection = await _invoke_structured_stage(
                                    structured_model,
                                    FinalSelection,
                                    system=_FINAL_SELECTION_PROMPT,
                                    content=_final_selection_content(
                                        cards=generated_cards,
                                        evaluations=evaluations,
                                        limit=target_cards,
                                        current_date=current_date,
                                    ),
                                    run_id=run_id,
                                    user_id=user_id,
                                    stage="final_selection",
                                )
                                if not isinstance(final_selection, FinalSelection):
                                    msg = (
                                        f"final selection did not return FinalSelection; "
                                        f"got {type(final_selection).__name__}. run_id={run_id}."
                                    )
                                    raise ValueError(msg)
                                ranked_cards = _apply_final_selection(
                                    cards=generated_cards,
                                    evaluations=evaluations,
                                    selection=final_selection,
                                    limit=target_cards,
                                )
                                final_selection_notes = final_selection.notes
                                logger.info(
                                    "generator stage ok run_id=%s stage=final_selection cards=%d",
                                    run_id,
                                    len(ranked_cards),
                                )
                            except Exception as e:
                                logger.warning(
                                    "generator final selection failed run_id=%s error=%s",
                                    run_id,
                                    e,
                                )
                        result = {
                            "structured_response": GeneratorOutput(
                                reasoning=(
                                    "Fixed pipeline ran deterministic context builder, planner, "
                                    "parallel card generators, and parallel evaluators. "
                                    f"Planner notes: {plan.notes} "
                                    f"Final selection notes: {final_selection_notes}"
                                ),
                                cards=ranked_cards,
                                evaluations=evaluations,
                                batch_feedback=(
                                    f"Generated {len(generated_cards)} candidates; "
                                    f"ranked {len(ranked_cards)} for final response."
                                ),
                            )
                        }
    finally:
        pass

    structured = result.get("structured_response")
    if not isinstance(structured, GeneratorOutput):
        # Should not happen — response_format=GeneratorOutput guarantees
        # the runtime returns one. If it does, the model failed schema
        # validation past the runtime's retry budget.
        msg = (
            f"generator pipeline did not return GeneratorOutput; "
            f"got {type(structured).__name__}. run_id={run_id}."
        )
        raise ValueError(msg)

    # ── auto-consume world signals cited in cards ──────────────────
    # The card-generator's prompt instructs it to cite world items as
    # "world id=world_xxx, title=...". We scan the final cards' sources
    # array and POST consume for each id we find. This flips the user's
    # pai_world_signal_user_view row from 'open' → 'consumed' so the
    # next ingest cycle / next generator run won't re-surface the same
    # news item. Best-effort: consume failures don't fail the run
    # (the cards have already been generated; consume is bookkeeping).
    consumed = await _auto_consume_world_signals(
        cards=structured.cards,
        run_jwt=run_jwt,
        run_id=run_id,
    )

    logger.info(
        "generator ok run_id=%s cards=%d evals=%d world_consumed=%d",
        run_id,
        len(structured.cards),
        len(structured.evaluations),
        consumed,
    )
    return structured


# Match `world id=world_xxx` (with optional whitespace) in a sources entry.
_WORLD_ID_RE = re.compile(r"world\s+id\s*=\s*(world_[A-Za-z0-9_-]{8,64})", re.IGNORECASE)


async def _auto_consume_world_signals(
    *,
    cards: list[Any],
    run_jwt: str,
    run_id: str,
) -> int:
    """Scan cards' sources for `world id=world_...` patterns and POST
    /api/agent/world/consume for each unique id. Returns count of
    successful consumes."""
    import os  # noqa: PLC0415

    import httpx  # noqa: PLC0415

    seen: set[str] = set()
    for card in cards:
        for src in getattr(card, "sources", []) or []:
            for m in _WORLD_ID_RE.finditer(src or ""):
                seen.add(m.group(1))
    if not seen:
        return 0

    base = os.environ.get("WEB_INTERNAL_URL", "http://pinai-web:8000")
    headers = {"Authorization": f"Bearer {run_jwt}"}
    consumed = 0
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
    ) as cli:
        for sig_id in seen:
            try:
                resp = await cli.post(
                    f"{base}/api/agent/world/consume",
                    headers=headers,
                    json={"id": sig_id, "runId": run_id},
                )
                if resp.status_code in (200, 204):
                    consumed += 1
                else:
                    logger.warning(
                        "world.consume failed run_id=%s id=%s status=%s",
                        run_id,
                        sig_id,
                        resp.status_code,
                    )
            except Exception:
                logger.warning(
                    "world.consume error run_id=%s id=%s",
                    run_id,
                    sig_id,
                    exc_info=True,
                )
    return consumed
