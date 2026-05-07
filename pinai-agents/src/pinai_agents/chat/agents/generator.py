"""Unified generator — orchestrator + 4 subagents.

Topology (one Daytona sandbox shared across all 5 agents):

    main (sonnet 4.6, response_format=GeneratorOutput)
      ├─ task("data-collector", "...")    — sonnet, writes /state/phase1.json
      ├─ task("planner", "...")           — sonnet, response_format=PlanOutput
      ├─ task("card-generator", "...")    — sonnet, response_format=CardsList
      └─ task("evaluator", "...")         — gpt-5.5, response_format=EvalReport

Why 4 subagents instead of one big prompt:

  - Context isolation: data-collector's raw 30-row gmail/signals dump
    never enters the planner / generator / evaluator context windows.
    Each LLM call sees only what it needs to decide.
  - Specialization: planner reasons about dedup / feedback alignment;
    generator focuses on writing high-quality cards; evaluator reviews
    them with a CRITIC prompt and a CROSS-FAMILY model (gpt-5.5) so
    "self-review" actually has independent perspective.
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
    profile, memory, signals, gmail, gcal, cards_recent, feedback = await asyncio.gather(
        client.profile.get(),
        client.memory.list(min_quality=0.7, limit=30),
        client.signals.recent(status="open", hours=24),
        client.raw.gmail.recent(),
        client.raw.gcal.today(),
        client.cards.recent(limit=30),
        client.feedback.list(limit=50),
        return_exceptions=True,
    )
    keys = ["profile","memory","signals","gmail","gcal","cards_recent","feedback"]
    digest = {}
    for k, v in zip(keys, [profile, memory, signals, gmail, gcal, cards_recent, feedback]):
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
Read `/state/phase1.json` and decide which {cards_to_generate} Intent
Cards to generate next. Your output is a structured Plan — not the
cards themselves. The card-generator subagent will turn each plan item
into a full card.
</role>

<workflow>
1. `read_file('/state/phase1.json')` — full JSON digest from data-collector.
2. Reason through dedup and feedback alignment BEFORE proposing items.
3. Emit a PlanOutput with:
     - `plan[]`: each item = {{intent_key, goal_basket, decision,
       why_now_trigger, primary_source_ids}}
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
  duplicate or a cold-basket item without fresh evidence.
</dedup_and_feedback_rules>

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
3. Output a CardsList with one GeneratedCard per plan item you can
   ground. If a plan item lacks the source data needed to write a
   solid card, drop it and add the intent_key to `skipped_plan_items`.
</workflow>

<card_quality_rules>
Every card must meet ALL:
- title: action-led, ≤ 80 chars, specific (verb + concrete object)
- whyNow: one sentence with a CONCRETE trigger (date / number / event)
- summary: 2-4 sentences of compressed context — enough to decide
- primary_action: concrete verb + object button label
- sources: at least one verbatim citation per source layer used,
  formatted as "signal id=sig_..., title=...", "memory id=mem_...,
  text=...", "gmail message id=..., subject=...", "profile id=primary,
  display_name='...', summary='...'", etc. The reader (evaluator
  subagent) MUST be able to find each cited id back in phase1.json.
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

overall = average of 5 dims. pass = overall >= 5.0 AND no grounding
violation (every cited id must look plausibly extractable from a
real data source — flag fabrications by failing).
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

1. `task(subagent_type="data-collector", description="Pull all 7 sources and persist /state/phase1.json. Today is {current_date}. Target {cards_to_generate} cards.")`
   → Returns a one-line summary. Sandbox file `/state/phase1.json` is
   now populated. If the summary reports a fatal error (auth /
   sandbox), STOP and emit a GeneratorOutput with cards=[],
   evaluations=[], and the error in batch_feedback.

2. `task(subagent_type="planner", description="Read /state/phase1.json and produce a plan for {cards_to_generate} cards. Today is {current_date}. {lang_clause}.")`
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
- If any subagent returns an error or empty result, emit a
  GeneratorOutput shell (empty cards / evaluations) with the failure
  in batch_feedback. NEVER fabricate cards.
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
    backend, _ = await get_or_create_thread_sandbox(session_key, run_jwt=run_jwt)
    try:
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
            # Reasoning posture per agent:
            #   data_collector — no response_format, stays on Sonnet with
            #     extended thinking (phase 1 is the most reasoning-heavy:
            #     "which sources matter" + "how to chunk the script").
            #   planner / card_generator / orchestrator — have
            #     response_format, which langchain implements via forced
            #     tool_choice. Anthropic rejects extended-thinking +
            #     forced tool_choice. We switch these to gpt-5.5 so they
            #     get OpenAI's built-in reasoning (compatible with
            #     structured output) instead of running without any
            #     reasoning at all. Reasoning text isn't surfaced by
            #     OpenAI's chat.completions API — only reasoning_tokens
            #     in usage — so traces show "the model thought" without
            #     the chain-of-thought text.
            data_collector = create_deep_agent(
                model=make_chat_model(virtual_key=virtual_key, thinking_budget=4000),
                system_prompt=_DATA_COLLECTOR_PROMPT,
                backend=backend,
            )
            planner = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="gpt-5.5",
                    enable_thinking=False,
                    enable_prompt_cache=False,
                ),
                system_prompt=_PLANNER_PROMPT.format(cards_to_generate=cards_to_generate),
                backend=backend,
                response_format=PlanOutput,
            )
            card_generator = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="gpt-5.5",
                    enable_thinking=False,
                    enable_prompt_cache=False,
                ),
                system_prompt=_CARD_GENERATOR_PROMPT.format(
                    lang_clause=_lang_clause(output_language),
                ),
                backend=backend,
                response_format=CardsList,
            )
            # Evaluator uses gpt-5.5 (cross-family) for genuinely
            # independent perspective. Same-family critic ends up
            # rubber-stamping its sibling's output (8/8 pass at 7.2-8.6
            # was the symptom of self-evaluation in the old design).
            # gpt-5.5 has internal reasoning by default (no separate
            # `thinking` parameter — the reasoning_tokens path is
            # always-on and compatible with structured output / tool_choice
            # unlike Anthropic).
            evaluator = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="gpt-5.5",
                    enable_thinking=False,  # gpt-5.5 reasoning is built-in
                    enable_prompt_cache=False,  # OpenAI doesn't honor Anthropic cache hints
                ),
                system_prompt=_EVALUATOR_PROMPT,
                backend=backend,
                response_format=EvalReport,
            )

            orchestrator = create_deep_agent(
                model=make_chat_model(
                    virtual_key=virtual_key,
                    model="gpt-5.5",
                    enable_thinking=False,
                    enable_prompt_cache=False,
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
                        "description": "Takes a CardsList inline, returns an EvalReport (5-dim scores + pass/fail + batch_feedback). CROSS-FAMILY model (gpt-5.5) for independent critique. Use ONCE after card-generator.",
                        "runnable": evaluator,
                    },
                ],
            )

            result: dict[str, Any] = await orchestrator.ainvoke(
                {"messages": [{"role": "user", "content": user_message}]}
            )
    finally:
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
    logger.info(
        "generator ok run_id=%s cards=%d evals=%d",
        run_id, len(structured.cards), len(structured.evaluations),
    )
    return structured
