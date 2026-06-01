"""Unified generator — orchestrator + 4 subagents.

Topology (one Daytona sandbox shared across all 5 agents):

    main (sonnet 4.6, response_format=GeneratorOutput)
      ├─ task("data-collector", "...")    — sonnet, writes /state/phase1.json
      ├─ task("planner", "...")           — sonnet, response_format=PlanOutput
      ├─ task("card-generator", "...")    — sonnet, response_format=CardsList
      └─ task("evaluator", "...")         — sonnet, response_format=EvalReport

Why 4 subagents instead of one big prompt:

  - Context isolation: data-collector's raw 30-row gmail/signals dump
    never enters the planner / generator / evaluator context windows.
    Each LLM call sees only what it needs to decide.
  - Specialization: planner reasons about dedup / feedback alignment;
    generator focuses on writing high-quality cards; evaluator reviews
    them with a CRITIC prompt against the same CardsList output.
  - Schema enforcement at the LLM layer: each subagent's
    `response_format` is a Pydantic model, validated by the model
    runtime. Replaces the old hand-written `parse_generator_output` +
    `is_complete_generator_output` + grounding checks (now schema-level
    via `min_length=1` on `sources[]`).

Why share one sandbox backend:
  Sandbox is per-(thread_id) Daytona resource. Subagents inherit the
  main agent's `runtime.state` (deepagents internal — see
  SubAgentMiddleware._validate_and_prepare_state), but the BACKEND
  itself isn't in state — it's closure-bound to each compiled agent.
  Threading the same `backend` instance into all 5
  `create_deep_agent(...)` calls is what makes filesystem / execute
  hit the same Daytona sandbox; otherwise each subagent would spawn
  its own and `read_file('/state/phase1.json')` would 404.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from deepagents import create_deep_agent

from ...shared.api_models import (
    CardsList,
    EvalReport,
    GeneratorOutput,
    PlanOutput,
)
from ..runtime.ctx import run_context
from ..runtime.llm import make_chat_model
from ..tools.local_sandbox import create_local_sandbox_backend, use_local_sandbox
from ..tools.sandbox import evict_thread, get_or_create_thread_sandbox

logger = logging.getLogger(__name__)


# ── Subagent prompts ────────────────────────────────────────────────
# Each prompt is single-purpose. They share one convention: state files
# live under `/state/` in the sandbox. data-collector writes phase1.json,
# everything else reads from there.

_DATA_COLLECTOR_PROMPT = """You are the data-collector subagent of the Pin AI card generator.

<role>
You pull the user's current data via `pinai_sdk` running inside the
shared Daytona sandbox, and persist a JSON digest to
`/state/phase1.json` for the downstream planner / generator / evaluator
to consume. You produce NO cards, NO plan, NO opinions — just data.
</role>

<workflow>
Use Code Mode: `write_file('/tmp/collect.py', <SCRIPT>)` then
`execute('python3 /tmp/collect.py')`. The sandbox has `pinai_sdk`
pre-installed; auth via env-injected phantom token, you do not handle
credentials.

The SDK exports a SINGLETON `client` (NOT a class — do NOT write
`from pinai_sdk import PinAIClient` or `PinAIClient()`):

```python
from pinai_sdk import client  # this exact import — singleton
```

Use this canonical script verbatim (adapt only if a source must be
re-fetched after a transient failure):

```python
import asyncio, json
from pathlib import Path
from pinai_sdk import client

async def main():
    (profile, memory, signals, gmail, gcal,
     cards_recent, feedback, world, preferences) = await asyncio.gather(
        client.profile.get(),
        client.memory.list(min_quality=0.7, limit=30),
        client.signals.recent(status="open", hours=24, min_salience=0.1, limit=80),
        client.raw.gmail.recent(),
        client.raw.gcal.today(),
        client.cards.recent(limit=30),
        client.feedback.list(limit=50),
        client.world.recent(status="open", limit=10),
        client.preferences.list(status="active", limit=50),
        return_exceptions=True,
    )
    ambient_signal_details = []
    if isinstance(signals, list):
        ambient_ids = [
            str(s.get("id")) for s in signals
            if isinstance(s, dict)
            and s.get("kind") == "ambient.candidate_window"
            and s.get("id")
        ][:20]
        if ambient_ids:
            ambient_signal_details = await asyncio.gather(
                *(client.signals.get(signal_id) for signal_id in ambient_ids),
                return_exceptions=True,
            )
    keys = ["profile","memory","signals","gmail","gcal",
            "cards_recent","feedback","world","preferences",
            "ambient_signal_details"]
    vals = [profile, memory, signals, gmail, gcal,
            cards_recent, feedback, world, preferences,
            ambient_signal_details]
    digest = {}
    for k, v in zip(keys, vals):
        if isinstance(v, BaseException):
            digest[k] = {"_error": f"{type(v).__name__}: {v}"}
        else:
            digest[k] = v
    Path("/state").mkdir(parents=True, exist_ok=True)
    out = json.dumps(digest, default=str, indent=2)
    Path("/state/phase1.json").write_text(out)
    summary = {k: ("error" if isinstance(digest[k], dict) and "_error" in digest[k]
                   else (f"{len(digest[k])} rows" if isinstance(digest[k], list)
                         else "ok"))
               for k in keys}
    print(f"phase1 written: {len(out)} bytes, {summary}")

asyncio.run(main())
```

After `execute` returns, just confirm "phase1 written" succeeded.
DO NOT print the digest body. The downstream subagents `read_file`
the file directly.
</workflow>

<no_fabrication>
If a source returns `_error`, surface it. Never invent data. If
`pinai_sdk` itself fails (auth, sandbox unreachable), STOP and report
the error verbatim — downstream agents will skip the run.
</no_fabrication>

<output>
Return only a brief plain-text summary (no JSON, no markdown), e.g.:
"phase1 written: profile=ok, memory=10 rows, signals=14 open,
gmail=3, gcal=0 (empty), cards_recent=4, feedback=0 (empty)."
The actual data is in `/state/phase1.json`.
</output>
"""


_PLANNER_PROMPT = """You are the planner subagent of the Pin AI card generator.

<role>
Read `/state/phase1.json` and decide which Intent Cards to generate next.
For an explicit generator run, produce 1-{cards_to_generate} planned
items whenever phase1 contains any usable grounded source. Return zero
items only when every source is empty/error or every candidate would be
unambiguously harmful, hallucinated, or impossible to ground.
Your output is a structured Plan — not the cards themselves. The
card-generator subagent will turn each plan item into a full card.
</role>

<workflow>
1. `read_file('/state/phase1.json')` — full JSON digest from data-collector.
2. `read_file('/state/matched_patterns.json')` — candidates the web-side
   pattern matcher already verified are triggerable. Each item has
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
`/state/phase1.json` has a `preferences` array — the user's OWN stated
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

<ambient_transcript_attribution>
`/state/phase1.json` may include `ambient.candidate_window` signals and
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

<output>
Your `response_format` is `PlanOutput`. Validation will reject
free-form prose. Stay strictly within the schema.
</output>
"""


_CARD_GENERATOR_PROMPT = """You are the card-generator subagent of the Pin AI card generator.

<role>
Take the plan from the orchestrator and write the actual Intent Cards.
You are the ONLY subagent that produces user-facing card text.
</role>

<workflow>
1. The orchestrator gives you a plan inline (PlanOutput JSON). For
   each plan item, write one card.
2. Source data is in `/state/phase1.json` — `read_file` it to look up
   any source body you need to cite verbatim (gmail subjects, signal
   summaries, memory text). Don't paraphrase a source name; quote it.
3. When `plan_item.pattern_id` is set, `read_file('/state/matched_patterns.json')`
   and find the matching entry. Use its `evidence` field to ensure every
   signal source the pattern requires actually appears as a verbatim
   citation in `sources[]`. Use `humanInsight` + `cardSkeleton.title_strategy`
   to choose the title angle and action. The pattern's abstract / category
   should inform tone but not be quoted to the user.
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
  (for items pulled from phase1's `world` layer — global news), etc.
  The reader (evaluator subagent) MUST be able to find each cited id
  back in phase1.json. World-signal citations are how downstream
  auto-consume identifies which news items the run actually used.
- ambient transcript citations must preserve attribution. `self:` or
  `payload.self_text` can support user intent; non-self speaker labels
  can support context only. Do not write "you said" unless the cited
  source is `self`.
- {lang_clause}. For Chinese strings, use 「」 or 《》 — NEVER ASCII
  double-quote inside a JSON string field.
</card_quality_rules>

<output>
`response_format` is `CardsList`. The schema enforces `sources[]`
non-empty per card; the LLM runtime will reject malformed output.
</output>
"""


_EVALUATOR_PROMPT = """You are the evaluator subagent of the Pin AI card generator.

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
  signal type required by that pattern (read
  `/state/matched_patterns.json`, find the entry, inspect its `evidence`
  keys) must appear in `sources[]` with a verbatim citation. The
  combination of signals must also be visible in the card copy — not
  just listed in `sources[]`. When the pattern includes
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
"""


_MAIN_ORCHESTRATOR_PROMPT = """You are the Pin AI **card-generation orchestrator**.

You do NOT pull data, write cards, or score them yourself. You
sequence four subagents and assemble their structured outputs into
the final `GeneratorOutput`.

<sequence>
You MUST execute these four `task` calls in this exact order. Do not
skip, reorder, or run in parallel — each step depends on the previous
step's side-effects (sandbox files) or its returned JSON.

1. `task(subagent_type="data-collector", description="Pull all 8 sources (profile / memory / signals / gmail / gcal / cards_recent / feedback / world) and persist /state/phase1.json. Today is {current_date}. Target {cards_to_generate} cards.")`
   → Returns a one-line summary. Sandbox file `/state/phase1.json` is
   now populated. If the summary reports a fatal error (auth /
   sandbox), STOP and emit a GeneratorOutput with cards=[],
   evaluations=[], and the error in batch_feedback.

2. `task(subagent_type="planner", description="Read /state/phase1.json and produce a grounded plan for 1-{cards_to_generate} cards whenever any usable source exists. Return zero only if every source is empty/error or impossible to ground. Today is {current_date}. {lang_clause}.")`
   → Returns a PlanOutput JSON. Inspect it. If `plan` is empty,
   STOP and emit GeneratorOutput with cards=[], evaluations=[], and
   the planner's `notes` in batch_feedback.

3. `task(subagent_type="card-generator", description="Plan: <PASTE THE PlanOutput JSON FROM STEP 2 HERE VERBATIM>. Read /state/phase1.json for source citations. {lang_clause}. Today is {current_date}.")`
   → Returns a CardsList JSON. The plan goes inline in the
   description so the card-generator has full context without
   another file roundtrip.

4. `task(subagent_type="evaluator", description="Cards to evaluate: <PASTE THE CardsList JSON FROM STEP 3 HERE VERBATIM>. Score strictly per the calibration rules.")`
   → Returns an EvalReport JSON.
</sequence>

<final_assembly>
After all four steps, emit ONE GeneratorOutput. Field rules:

- `reasoning`: one paragraph — which subagents fired, dedup decisions
  the planner made (cite from PlanOutput.notes), basket distribution,
  why count == N (if fewer than {cards_to_generate}, why).
- `cards`: from CardsList.cards, FILTERED to only those whose
  matching CardEvaluation has pass==true. Drop the rest.
- `evaluations`: the full EvalReport.evaluations (including failed —
  audit trail for why a card was dropped).
- `batch_feedback`: synthesize EvalReport.batch_feedback +
  PlanOutput.notes. Mention skipped duplicates and cold baskets.
</final_assembly>

<hard_rules>
- Today is {current_date}.
- {lang_clause} for any user-visible text in the final cards (the
  card-generator subagent enforces this; you just thread the
  language through descriptions).
- Pass plan/cards JSON inline in description verbatim — do NOT
  summarize. Subagents need full structure to do their job.
- If a subagent returns an error, emit a GeneratorOutput shell (empty
  cards / evaluations) with the failure in batch_feedback. NEVER
  fabricate cards.
- If planner or card-generator returns empty while phase1 was written
  successfully, do one recovery pass: ask the same subagent to produce
  one conservative, well-grounded card from the strongest available
  source. Only return empty after that recovery pass also finds no
  grounded candidate.
</hard_rules>

<output>
`response_format` is `GeneratorOutput`. Output exactly one validated
instance, nothing else.
</output>
"""


def _lang_clause(output_language: str) -> str:
    if output_language in ("zh-Hans", "zh"):
        return "Use Simplified Chinese for all user-visible text fields"
    return "Use English for all user-visible text fields"


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
) -> GeneratorOutput:
    """One-shot generator run. Returns the validated GeneratorOutput.

    A Daytona thread sandbox is provisioned keyed on `gen-{run_id}`.
    All five agents (orchestrator + 4 subagents) share it via the same
    `backend` instance — that's the only way `read_file('/state/...')`
    in one subagent finds files written by another. Evicted in finally;
    the registry won't cache it past this call.

    Caller responsibilities:
      - current_date in YYYY-MM-DD.
      - user_id / run_id / run_jwt — `tools/sandbox.py` mints the
        phantom token consumed by `pinai_sdk` env in the sandbox.
      - The returned GeneratorOutput is already validated (Pydantic);
        no further parse / shape check needed.
    """
    session_key = f"gen-{run_id}"
    is_local_sandbox = use_local_sandbox()
    if is_local_sandbox:
        backend = create_local_sandbox_backend(
            run_jwt=run_jwt,
            root_dir="/state",
            reset_files=("phase1.json", "matched_patterns.json"),
        )
        logger.info("generator using local sandbox backend run_id=%s", run_id)
    else:
        backend, _ = await get_or_create_thread_sandbox(session_key, run_jwt=run_jwt)
    try:
        # Stage matched_patterns to /state so the planner subagent can
        # read_file('/state/matched_patterns.json'). Empty list still gets
        # written so the planner has a deterministic file to read.
        try:
            import json as _json  # noqa: PLC0415

            await backend.awrite(
                "/state/matched_patterns.json",
                _json.dumps(matched_patterns or [], ensure_ascii=False),
            )
        except Exception:
            logger.warning(
                "failed to stage matched_patterns.json for run=%s — planner will fall back to free-LLM",
                run_id,
                exc_info=True,
            )
        with run_context(
            user_id=user_id,
            run_id=run_id,
            run_jwt=run_jwt,
            virtual_key=virtual_key,
            session_key=session_key,
        ):
            # Subagents — each is a CompiledSubAgent so it inherits the
            # FilesystemMiddleware (read_file / write_file / execute)
            # bound to the SHARED `backend`. Without the shared backend
            # they'd spawn separate sandboxes and lose file continuity.
            #
            # All subagents run on claude-sonnet-4-6. The ones with
            # response_format (planner / card_generator / evaluator /
            # orchestrator) keep enable_thinking=False because langchain
            # implements response_format via forced tool_choice, which
            # Anthropic rejects when extended-thinking is on. Cache is
            # left at the default (on) so the shared system prompt /
            # last user turn ride Anthropic's prompt cache.
            data_collector = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="claude-sonnet-4-6",
                    enable_thinking=False,
                ),
                system_prompt=_DATA_COLLECTOR_PROMPT,
                backend=backend,
            )
            planner = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="claude-sonnet-4-6",
                    enable_thinking=False,
                ),
                system_prompt=_PLANNER_PROMPT.format(cards_to_generate=cards_to_generate),
                backend=backend,
                response_format=PlanOutput,
            )
            card_generator = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="claude-sonnet-4-6",
                    enable_thinking=False,
                ),
                system_prompt=_CARD_GENERATOR_PROMPT.format(
                    lang_clause=_lang_clause(output_language),
                ),
                backend=backend,
                response_format=CardsList,
            )
            evaluator = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="claude-sonnet-4-6",
                    enable_thinking=False,
                ),
                system_prompt=_EVALUATOR_PROMPT,
                backend=backend,
                response_format=EvalReport,
            )

            orchestrator = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="claude-sonnet-4-6",
                    enable_thinking=False,
                ),
                system_prompt=_MAIN_ORCHESTRATOR_PROMPT.format(
                    current_date=current_date,
                    cards_to_generate=cards_to_generate,
                    lang_clause=_lang_clause(output_language),
                ),
                backend=backend,
                response_format=GeneratorOutput,
                subagents=[
                    {
                        "name": "data-collector",
                        "description": "Pulls user data via pinai_sdk and writes /state/phase1.json. Use ONCE at the start of each generator run.",
                        "runnable": data_collector,
                    },
                    {
                        "name": "planner",
                        "description": "Reads /state/phase1.json, returns a PlanOutput (which N intent cards to generate, with dedup + feedback alignment). Use ONCE after data-collector.",
                        "runnable": planner,
                    },
                    {
                        "name": "card-generator",
                        "description": "Takes a PlanOutput inline, returns a CardsList (full GeneratedCard objects). Use ONCE after planner.",
                        "runnable": card_generator,
                    },
                    {
                        "name": "evaluator",
                        "description": "Takes a CardsList inline, returns an EvalReport (5-dim scores + pass/fail + batch_feedback). Use ONCE after card-generator.",
                        "runnable": evaluator,
                    },
                ],
            )

            result: dict[str, Any] = await orchestrator.ainvoke(
                {"messages": [{"role": "user", "content": user_message}]},
                config={
                    "metadata": {
                        "pinai_run_id": run_id,
                        "pinai_user_id": str(user_id),
                        "pinai_agent": "generator",
                    },
                    "tags": ["pinai", "generator", f"pinai_run:{run_id}"],
                },
            )
    finally:
        if not is_local_sandbox:
            await evict_thread(session_key)

    structured = result.get("structured_response")
    if not isinstance(structured, GeneratorOutput):
        # Should not happen — response_format=GeneratorOutput guarantees
        # the runtime returns one. If it does, the model failed schema
        # validation past the runtime's retry budget.
        msg = (
            f"orchestrator did not return GeneratorOutput; "
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
