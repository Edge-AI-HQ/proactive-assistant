"""Unified generator agent (Step 1.5).

Ports the TS `pinai-openclaw/plugins/proactive-ai/agents/unified-generator.ts`
prompt's *output contract* — JSON with `cards` / `evaluations` /
`batchFeedback` — but Phase 1 context gathering is stubbed because we have
no pin CLI / no user data in Step 1. Step 2 wires real Agent API tools
(Phase 1 returns) and the prompt expands accordingly.

Scope deliberately small:
    - No backend (default StateBackend, in-memory).
    - No tools beyond DeepAgents default scaffolding (todo / fs / subagent).
    - No streaming — single ainvoke(), JSON parsed from final assistant msg.
    - No checkpointer (each /agent/generate call is independent; the run_id
      is for traceability, not state continuation).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from deepagents import create_deep_agent

from ..llm import make_chat_model
from ..sandbox import create_oneshot_sandbox, delete_sandbox_now

logger = logging.getLogger(__name__)


def build_system_prompt(
    *,
    current_date: str,
    cards_to_generate: int = 4,
    output_language: str = "en",
) -> str:
    """Build the unified-generator system prompt for Step 1.

    Stripped down vs the TS version:
        - Phase 1 (context gathering via pin CLI) → "no data available" stub
          telling the agent to generate plausible scenarios.
        - Phase 2-4 retained: plan, generate, self-review.
        - Output contract retained verbatim — JSON cards / evaluations /
          batchFeedback. APIs / front-end consumers should be wire-compatible.
    """
    lang_clause = (
        "Use Simplified Chinese for all user-visible text fields"
        if output_language in ("zh-Hans", "zh")
        else "Use English for all user-visible text fields"
    )
    return f"""You are the Proactive AI card generator (Step 1 stub). Your job: produce {cards_to_generate} high-quality Intent Cards in a single pass and self-review them.

Today: {current_date}

{lang_clause} (title, whyNow, summary, actions, feedback, reasoning).

<role>
The Proactive AI system recommends pre-processed next-best-actions to the user. Each Intent Card = one decision the user can confirm, modify, or dismiss.
</role>

<step1_stub_disclaimer>
NOTE: This is a Step 1 framework-validation run. The data tools that normally feed Phase 1 context (memory / signals / raw connector data / profile) are NOT available in this environment. Generate plausible cards from generic professional scenarios instead. The goal is to produce a structurally correct JSON envelope so the rest of the pipeline can be validated; quality is not graded.
</step1_stub_disclaimer>

<output_contract>
Your final assistant message MUST contain exactly one fenced JSON block and no prose before or after it. Do not print phase summaries, planning notes, markdown bullets, or analysis outside the JSON. Keep `reasoning` ≤ 500 chars, each `evaluations[].feedback` ≤ 180 chars, `batchFeedback` ≤ 400 chars.
If you cannot fit {cards_to_generate} complete high-quality cards, emit fewer cards. Never let the JSON truncate.
</output_contract>

<phase_2_plan>
Decide which {cards_to_generate} Intent Cards to generate.

For each planned card, identify:
- Which goal basket (work / health / family / wealth / growth / life)
- Specific decision the user can make
- Concrete "why now" trigger (date, number, event)
- Default action the user can approve

Quality criteria:
- One decision per card.
- Specific "why now" — not vague.
- Default action = concrete verb + object.
- Diverse — different baskets where possible.
</phase_2_plan>

<phase_3_generate>
Generate the cards.

Standards (every card meets ALL):
- title: action-led, ≤ 80 chars, specific.
- whyNow: one sentence, concrete trigger.
- summary: 2–4 sentences of compressed context.
- primaryAction: concrete verb + object.
- evidence-backed: each card grounded in a plausible source described in `sources[]`.
</phase_3_generate>

<phase_4_self_review>
Score each card on 5 dims (0.0–10.0):
- relevance, actionability, whyNowClarity, novelty, decisionCompression.
overall = average. pass = overall ≥ 5.0.
</phase_4_self_review>

<output_format>
After completing all phases, output ONLY a JSON code block with this exact structure:

```json
{{
  "reasoning": "Brief summary (≤500 chars) of plan and any acknowledged stub limits.",
  "cards": [
    {{
      "id": "auto-assigned",
      "goalBasket": "work",
      "title": "...",
      "whyNow": "...",
      "summary": "...",
      "primaryAction": {{ "label": "...", "type": "confirm" }},
      "secondaryActions": [
        {{ "label": "Modify", "type": "modify" }},
        {{ "label": "Remind me later", "type": "snooze" }},
        {{ "label": "Not relevant", "type": "dismiss" }}
      ],
      "confidence": 0.7,
      "urgency": 0.6,
      "importance": 0.7,
      "sources": ["plausible source description"],
      "agentChain": ["unified-generator"],
      "createdAt": "{current_date}"
    }}
  ],
  "evaluations": [
    {{
      "cardId": "matches card id",
      "overall": 7.5,
      "dimensions": {{
        "relevance": 8.0,
        "actionability": 7.0,
        "whyNowClarity": 7.5,
        "novelty": 7.0,
        "decisionCompression": 8.0
      }},
      "feedback": "Brief note (≤180 chars).",
      "pass": true
    }}
  ],
  "batchFeedback": "Overall assessment (≤400 chars). Acknowledge stub-data context."
}}
```

- Include only cards that passed (overall ≥ 5.0).
- One evaluation per card.
- Card-field scores 0.0–1.0; evaluation dims 0.0–10.0.
- No prose outside the JSON fence.
- For Chinese strings, use 「」 or 《》 (NEVER ASCII " inside) to avoid quote-collision.
</output_format>"""


_OUTPUT_KEYS = {"reasoning", "cards", "evaluations", "batchFeedback"}


def parse_generator_output(text: str) -> dict[str, Any] | None:
    """Port of TS `parseAgentJson` — extract the fenced JSON block from the
    agent's final message. Returns None if the text is missing the fence or
    parses to invalid JSON.

    NOTE: caller decides whether the parsed object is *complete* (has
    cards / evaluations arrays). This function is shape-agnostic JSON parse
    only.
    """
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?\s*```", text)
    raw = fenced.group(1) if fenced else None
    if raw is None:
        # Fallback: braces-delimited blob
        brace = re.search(r"(\{[\s\S]*\})", text)
        raw = brace.group(1) if brace else None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        logger.info("generator JSON parse failed: %s", e)
        return None


def is_complete_generator_output(parsed: dict[str, Any] | None) -> bool:
    """Match the TS `isUnifiedGeneratorCompleteOutput` shape check."""
    if not isinstance(parsed, dict):
        return False
    if not isinstance(parsed.get("cards"), list):
        return False
    if not isinstance(parsed.get("evaluations"), list):
        return False
    for card in parsed["cards"]:
        if not isinstance(card, dict):
            return False
        title = card.get("title")
        if not isinstance(title, str) or not title.strip():
            return False
    return True


async def run_generator(
    *,
    virtual_key: str,
    current_date: str,
    cards_to_generate: int = 4,
    output_language: str = "en",
    model: str | None = None,
    user_message: str = "Generate Intent Cards now.",
) -> dict[str, Any]:
    """One-shot generator run. Returns parsed JSON or raises on failure.

    A fresh Daytona sandbox is created for this run and deleted in finally.
    Generator is single-shot (no follow-up turns) so per-run sandbox is
    correct here — contrast with chat which uses thread-scoped sandboxes.

    Caller responsibilities:
        - Provide current_date in agreed format (YYYY-MM-DD typically).
        - Treat ValueError from this function as "model returned bad shape;
          retry / surface error to user".
    """
    system_prompt = build_system_prompt(
        current_date=current_date,
        cards_to_generate=cards_to_generate,
        output_language=output_language,
    )
    backend, raw = await create_oneshot_sandbox()
    try:
        agent = create_deep_agent(
            # Generator does multi-phase reasoning (plan + generate + self-review),
            # so we give it a bigger thinking budget than chat default.
            model=make_chat_model(
                virtual_key=virtual_key,
                model=model,
                thinking_budget=8000,
            ),
            system_prompt=system_prompt,
            backend=backend,
        )
        result: dict[str, Any] = await agent.ainvoke(
            {"messages": [{"role": "user", "content": user_message}]}
        )
    finally:
        await delete_sandbox_now(raw)

    msgs = result.get("messages", [])
    final_text = _final_assistant_text(msgs)
    parsed = parse_generator_output(final_text or "")
    if not is_complete_generator_output(parsed):
        raise ValueError(
            f"generator returned invalid output shape; final text head: {(final_text or '')[:200]!r}"
        )
    assert parsed is not None  # narrowed by is_complete check
    return parsed


def _final_assistant_text(messages: list[Any]) -> str | None:
    for msg in reversed(messages):
        role = getattr(msg, "type", None) or (msg.get("role") if isinstance(msg, dict) else None)
        if role not in ("ai", "assistant"):
            continue
        content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            parts = [
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            ]
            joined = "\n".join(p for p in parts if p)
            if joined.strip():
                return joined
    return None
