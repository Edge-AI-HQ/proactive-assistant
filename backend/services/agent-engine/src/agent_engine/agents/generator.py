"""Card generator — one multi-turn agent run per tick, cache-efficient context.

Design (docs/plans/2026-06-23-proactive-card-generation.mdx §四): every
trigger (manual / chat / scheduled — minute-level cron included) is one TICK
on a single per-user context line:

  [system: static prompt + portrait + day-granular date]      ← cached
  [arrival log: full blocks, byte-identical across ticks]     ← cached
  [tick msg: minute-level now + tail arrivals + future view]  ← the only miss

The log is rebuilt deterministically from (anchor, now) — no message log is
persisted, one timestamp is the whole state. Agent replies are never kept:
a generated card writes back an L1 agent_decision, which returns to the log
as a new arrival on the next tick (dedupe closes itself). The agent verifies
with `events_search` and submits 0..N cards through `submit_card` — 0 is a
normal, common outcome (precision over recall).

Cache breakpoints are marked explicitly in code (last full block + tick tail;
measured end-to-end 2026-07-04: consecutive user blocks survive the litellm →
Anthropic merge with cache_control intact, and glm's implicit cache reports
hits via `cached_tokens`). The backend is a LazyThreadSandbox the prompt
never invokes — a generator run never touches Daytona.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from langchain_core.tools import tool
from pinai_contracts.api_models import GeneratedCard, GeneratorOutput

from ..harness.ctx import run_context
from ..harness.factory import build_agent
from ..harness.llm import make_chat_model
from ..tools.code_mode.lazy_sandbox import LazyThreadSandbox
from ..tools.direct.events import event_source, events_search
from ..tools.direct.tavily import tavily_extract, tavily_search
from .generation_context import build_tick_context, default_anchor
from .prompts import lang_clause

logger = logging.getLogger(__name__)

# One agent loop: tick → a few events_search calls → up to 8 submit_card
# calls → closing summary. Each tool round costs 2 graph steps; 80 leaves
# generous headroom over langgraph's default 25 without letting a runaway
# loop burn unbounded turns.
_RECURSION_LIMIT = 80


# ── citations → sourceApps (frontend contract) ──────────────────────────────
#
# Cards cite L1 events as `{toolkit} event id={event id}, title=…` — the
# leading token is the app-granular toolkit from the event's
# structured.toolkit (projector stamps it), or the event source for
# non-connector events (world / device / ambient / agent_action).
_CITATION_TOKEN_TO_APP = {
    "gmail": "gmail",
    "googlecalendar": "gcal",
    "gcal": "gcal",
    "world": "web",
    "device": "device",
    "ambient": "ambient",
}

_CITATION_PREFIX_RE = re.compile(r"^\s*([a-z0-9_-]+)(?:\s+[a-z0-9_-]+)*\s+id=", re.IGNORECASE)


def derive_source_apps(sources: list[str]) -> list[str]:
    """Deterministic user-facing app slugs for a card's citation list.

    Unknown / garbled citations are dropped rather than guessed — the
    audit string itself must never leak to the UI."""
    apps: list[str] = []
    for citation in sources:
        match = _CITATION_PREFIX_RE.match(citation)
        if not match:
            continue
        token = match.group(1).lower()
        app = _CITATION_TOKEN_TO_APP.get(token, token)
        if app not in apps:
            apps.append(app)
    return apps


# ── submit_card: the agent's only write — collection + validation in one ──


def _make_submit_card_tool(collected: list[GeneratedCard], *, cap: int) -> Any:
    """Run-scoped `submit_card`. Pydantic (args_schema=GeneratedCard) rejects
    malformed cards with a validation error the agent can read and fix;
    accepted cards land in `collected` in submission order."""

    @tool("submit_card", args_schema=GeneratedCard)
    async def submit_card(**kwargs: Any) -> str:
        """Submit ONE finished card. Call once per card you decided to keep,
        AFTER verifying its events are real/current and it doesn't overlap a
        recent proposal. The schema is validated on submission — on a
        validation error, fix the named field and resubmit."""
        if len(collected) >= cap:
            return (
                f"REJECTED: this run already has {cap} cards (the maximum). "
                "Stop submitting and write your closing summary."
            )
        card = GeneratedCard(**kwargs)
        if any(existing.intent_key == card.intent_key for existing in collected):
            return (
                f"REJECTED: intent_key '{card.intent_key}' was already submitted "
                "this run. Submit each decision at most once."
            )
        collected.append(card)
        return f"accepted ({len(collected)}/{cap}): {card.intent_key}"

    return submit_card


# ── prompt ──


_GENERATOR_INSTRUCTIONS = """You are PIN AI's card generator — a background \
tick that turns the user's event timeline into Intent Cards for their Now \
page.

<context_map>
The conversation carries an EVENT LOG (one or more JSON blocks) followed by \
a tick message (current time + newest arrivals + the CURRENT UPCOMING \
SCHEDULE). Your standing view of the user (USER facts + preferences, GOALS) \
is above via <portrait> — preferences there are constraints, not suggestions.

How to read the log:
- Events appear in ARRIVAL order — the order the system learned about them, \
NOT time order. Reason about the actual timeline with each event's \
occurredAt; future events show up here as arrival notices.
- An event carrying `supersedes: X` REPLACES event X entirely — treat X as \
gone. The tick message's UPCOMING SCHEDULE is authoritative for what is \
valid NOW; when the log and the schedule disagree, the schedule wins.
- Entries with eventType=agent_decision and kind=proactive_proposal are \
YOUR OWN past card proposals (cardId + relatedEventIds included). Never \
propose the same underlying decision again, and never re-cite events from a \
proposal's relatedEventIds for the same purpose.
</context_map>

<job>
Decide what — if anything — deserves a card right now, verify it, then \
submit 0..N cards. There is NO quota: submitting nothing is a normal, common \
outcome. Importance is contextual — the same event matters more or less \
depending on the current time and what sits near it.
</job>

<what_deserves_a_card>
Patterns worth acting on (each still has to pass the bar in <card_rules> — \
a pattern match alone is not enough):
- Schedule collision or tight adjacency: two commitments that clash or \
leave no transition room (a reschedule landing next to tomorrow's interview).
- Approaching deadline with no sign of preparation in the timeline.
- Unplanned change that forces downstream adjustments: cancellation, \
reschedule, delay, payment failure.
- A fresh external change that touches a stated GOAL or portfolio/interest \
the user actually holds.
- A commitment the user made (in email/chat/meeting) whose due moment is \
approaching.
- An anomaly against the user's own baseline: unusual amount, frequency, \
place, or sender.
What does NOT deserve a card: routine newsletters, FYI-only notices, \
anything the user already handled, and anything you already proposed.
</what_deserves_a_card>

<tools>
- `events_search` — pull more context or confirm an event is current \
(semantic with a query; recent-by-type without).
- `event_source` — read an event's verbatim original when the decision \
hinges on details the log's 280-char body cut may have dropped (amounts, \
deadlines, exact asks).
- `tavily_search` / `tavily_extract` — for world/news candidates only: \
verify the fact is current and add concrete context. Verification and \
enrichment of a candidate you already have — never open-ended research, \
never looking for new topics.
- `submit_card` — one call per finished card.
Use nothing else. Do NOT use file or execute tools — this tick needs none.
</tools>

<workflow>
1. Read the tick message (time, fresh arrivals, upcoming schedule) against \
the log; shortlist candidates via <what_deserves_a_card>.
2. Verify each candidate with the tools above: events are real, current \
(not superseded), and the concrete details check out.
3. Drop any candidate overlapping your own past proposals (agent_decision \
arrivals).
4. Submit each survivor with one `submit_card` call. It validates the \
schema; on rejection, fix the named field and resubmit.
5. End with 1-3 plain sentences: what you saw and why you produced these \
cards (or none). Do not restate card contents.
</workflow>

<card_rules>
- Precision over recall. One bad card costs more than ten missed good ones. \
When unsure, don't submit.
- Ground every card in events you actually saw (log, tick message, or tool \
results). Each `sources` entry is exactly `{toolkit} event id={event id}, \
title={title}` — toolkit from the event's `toolkit` field (e.g. gmail, \
googlecalendar), or the event source for non-connector events (world, \
device, ambient). Never cite an id you did not see.
- title: ≤70 chars, ACTION-FIRST. Open with the action you can take for the \
user or already took (verb + object), then " — " + the concrete trigger \
fact / number / time. NEVER open with the news fact or number itself; avoid \
generic "I noticed…" / "you may like…" titles.
    GOOD: "Review your tech concentration — chip stocks fell 3% for a 2nd day"
    GOOD (zh-Hans): "帮你复查科技股持仓集中度 — 芯片股连跌两天"
    BAD : "Nasdaq -3% on Jun 9: chip selloff day 2" (fact-first)
    BAD : "Check your portfolio — something changed" (vague trigger)
- `why_now` names what makes TODAY the right time (a collision, a deadline, \
a fresh change) with a CONCRETE trigger, and must ADD context beyond the \
title's trigger clause — never restate the title.
- summary: 2-4 sentences of compressed context — enough to decide.
- `primary_action.agent_prompt` is the full task an execution agent runs \
after the user confirms — one sentence naming the concrete deliverable PLUS \
the key parameters from THIS card, so the agent has a real task spec.
- reasoning_steps: 2-4 steps (observed → cross_referenced → decided), each \
`detail` under 25 words and pointing only at data already cited in sources.
- Score confidence / urgency / importance against the rubrics in the \
submit_card schema — urgency 0.85+ shows the user an Urgent tag, so reserve \
it for real same-day stakes.
- Ambient/utterance citations must preserve attribution — do not write "you \
said" unless the cited content is the user's own speech.
- One card per underlying decision; no v2/near-duplicate angles. For Chinese \
strings use 「」 — never ASCII double-quotes inside JSON string fields.
</card_rules>
"""


def _system_prompt(output_language: str, *, current_date: str) -> str:
    return (
        f"{_GENERATOR_INSTRUCTIONS}\n"
        # Day-granular on purpose: the system segment must stay byte-stable
        # across ticks within a day (minute-level `now` lives in the tick
        # message, at the very END of the prompt — never up front).
        f"<current_date>Today is {current_date}.</current_date>\n"
        "<output_language>\n"
        f"{lang_clause(output_language)} — card titles/summaries are user-visible. "
        "intent_key, goal_basket, and citation shapes stay in English.\n"
        "</output_language>"
    )


def _cache_block(text: str, *, cached: bool, ttl: str) -> dict[str, Any]:
    """One user message whose single text block optionally carries an explicit
    cache_control breakpoint (survives the litellm→Anthropic merge — measured;
    a no-op passthrough on providers with implicit caching like glm). `ttl` is
    "5m" (≤5min tick cadence: the refresh-on-hit chain never goes cold) or
    "1h" (slower cadences — a 5m entry would expire between ticks and every
    run would pay the write premium for nothing). Decided api-side per user
    (design §4.3)."""
    block: dict[str, Any] = {"type": "text", "text": text}
    if cached:
        control: dict[str, Any] = {"type": "ephemeral"}
        if ttl != "5m":
            control["ttl"] = ttl
        block["cache_control"] = control
    return {"role": "user", "content": [block]}


def _tick_message(
    *,
    now: datetime,
    tail_events: list[dict[str, Any]],
    future_view: list[str],
    cap: int,
    focus: str | None,
    generation_request: dict[str, Any] | None,
) -> str:
    focus_clause = (
        f"USER FOCUS — the user explicitly asked for cards about: {focus}\n"
        "Prioritize candidates serving this focus; only add off-focus cards for "
        "clearly stronger evidence.\n"
        if focus
        else ""
    )
    request_clause = (
        f"<generation_request_json>{json.dumps(generation_request, ensure_ascii=False)}"
        "</generation_request_json>\n"
        if generation_request
        else ""
    )
    tail = (
        json.dumps(tail_events, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if tail_events
        else "none"
    )
    schedule = "\n".join(future_view) if future_view else "none"
    return (
        f"now = {now.strftime('%Y-%m-%dT%H:%M')}Z\n"
        f"{focus_clause}"
        f"{request_clause}"
        f"NEW ARRIVALS (after the log blocks above):\n{tail}\n\n"
        f"CURRENT UPCOMING SCHEDULE (authoritative, soonest first, next 7d):\n{schedule}\n\n"
        f"Judge why-now against the time above. Submit at most {cap} cards — 0 is fine."
    )


def _final_message_text(final: Any) -> str:
    """Text of the agent's final message — handles LangChain content blocks
    (list of {type:text}), plain string, and dict shapes."""
    if final is None:
        return ""
    content = final.get("content") if isinstance(final, dict) else getattr(final, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return str(content or "")


def _usage_totals(msgs: list[Any]) -> tuple[int, int]:
    """(prompt_tokens, cache_read_tokens) of the LARGEST model call in the run
    — i.e. the full-context call; the number the reset budget compares against.
    Zero when the provider returned no usage."""
    best_prompt = 0
    best_read = 0
    for m in msgs:
        usage = getattr(m, "usage_metadata", None)
        if not isinstance(usage, dict):
            continue
        prompt = int(usage.get("input_tokens") or 0)
        if prompt > best_prompt:
            details = usage.get("input_token_details") or {}
            best_prompt = prompt
            best_read = int(details.get("cache_read") or 0)
    return best_prompt, best_read


async def run_generator(
    *,
    virtual_key: str,
    current_date: str,
    user_id: int,
    run_id: str,
    run_jwt: str,
    anchor: datetime | None = None,
    cache_ttl: str = "5m",
    cards_to_generate: int = 8,
    output_language: str = "en",
    focus: str | None = None,
    generation_request: dict[str, Any] | None = None,
) -> GeneratorOutput:
    """One tick: rebuild the cache-stable context from (anchor, now), run the
    multi-turn agent, return 0..N submitted cards.

    `anchor` is the per-user context anchor (api-managed, design §4.2); None
    means a fresh line (reset semantics — log starts from now − LOOKBACK).
    `cards_to_generate` is a CAP, not a target. The route's asyncio.timeout
    bounds the run. `GeneratorOutput.prompt_tokens` carries the largest
    call's usage so the api side can apply the reset budget."""
    session_key = f"gen-{run_id}"
    cap = max(1, min(cards_to_generate, 8))
    now = datetime.now(UTC)
    requested_anchor = anchor or default_anchor(now)
    with run_context(
        user_id=user_id,
        run_id=run_id,
        run_jwt=run_jwt,
        virtual_key=virtual_key,
        session_key=session_key,
    ):
        ctx = await build_tick_context(anchor=requested_anchor, now=now)
        # == requested normally; == now if the build hit the log budget and
        # reset in place. Returned to the api side, which persists it.
        effective_anchor: datetime = ctx["effective_anchor"]

        messages: list[dict[str, Any]] = []
        blocks: list[str] = ctx["log_blocks"]
        for i, block_text in enumerate(blocks):
            # Only the LAST full block carries the breakpoint — one entry
            # covers the whole prefix up to and including it (design §4.3).
            messages.append(
                _cache_block(
                    f"EVENT LOG block {i + 1}/{len(blocks)} (arrival order):\n{block_text}",
                    cached=(i == len(blocks) - 1),
                    ttl=cache_ttl,
                )
            )
        messages.append(
            _cache_block(
                _tick_message(
                    now=now,
                    tail_events=ctx["tail_events"],
                    future_view=ctx["future_view"],
                    cap=cap,
                    focus=focus,
                    generation_request=generation_request,
                ),
                # Tick-tail breakpoint serves the run's own multi-turn tool
                # loop (the prefix grows within the run).
                cached=True,
                ttl=cache_ttl,
            )
        )

        collected: list[GeneratedCard] = []
        agent = build_agent(
            model=make_chat_model(virtual_key=virtual_key, enable_thinking=False),
            system_prompt=_system_prompt(output_language, current_date=current_date),
            # Never provisions: the prompt forbids file/exec tools, and
            # LazyThreadSandbox only touches Daytona on first file/exec use.
            backend=LazyThreadSandbox(session_key, run_jwt=run_jwt),
            tools=[
                events_search,
                # Drill into an event's L0 verbatim content — the log's narrow
                # projection caps body at 280 chars; card specificity (amounts,
                # deadlines, exact asks) usually lives past that.
                event_source,
                # Web context for world/news candidates — verify & enrich only,
                # never open-ended research (prompt-enforced).
                tavily_search,
                tavily_extract,
                _make_submit_card_tool(collected, cap=cap),
            ],
            # Resident L2 portrait (USER/GOALS incl. distilled preferences).
            with_portrait=True,
        )
        result = await agent.ainvoke(
            {"messages": messages},
            config={"recursion_limit": _RECURSION_LIMIT},
        )

    msgs = result.get("messages", []) if isinstance(result, dict) else []
    reasoning = _final_message_text(msgs[-1] if msgs else None)
    prompt_tokens, cache_read = _usage_totals(msgs)
    logger.info(
        "generator tick ok run_id=%s cards=%d turns=%d anchor=%s "
        "prompt_tokens=%d cache_read=%d blocks=%d tail=%d",
        run_id,
        len(collected),
        len(msgs),
        effective_anchor.isoformat(),
        prompt_tokens,
        cache_read,
        len(ctx["log_blocks"]),
        len(ctx["tail_events"]),
    )
    return GeneratorOutput(
        reasoning=reasoning[:3000],
        cards=list(collected),
        # The evaluator stage is retired — verification happens inside the
        # run (submit_card is called only after the agent checked the card).
        evaluations=[],
        batch_feedback="",
        prompt_tokens=prompt_tokens,
        cache_read_tokens=cache_read,
        effective_anchor=effective_anchor,
    )
