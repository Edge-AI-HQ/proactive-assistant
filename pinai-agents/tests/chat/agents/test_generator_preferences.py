"""Goal 2 plumbing: active preferences reach generation.

These are plumbing assertions only — that the deterministic context
builder exists, that the planner prompt carries the preference-alignment
instruction, and that the SDK still exposes the preference surface used by
agent code. Whether the planner actually biases toward a preference is an
LLM behavior, verified manually against a LangSmith trace, never asserted
here.
"""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest

from pinai_agents.chat.agents import generator as generator_module
from pinai_agents.chat.agents.generator import (
    _CARD_GENERATOR_PROMPT,
    _EVALUATOR_PROMPT,
    _PLANNER_PROMPT,
    _build_source_index,
    _card_writer_content,
    _compact_phase1_for_planner,
    _source_bundle_for_plan_item,
    run_generator,
)
from pinai_agents.chat.agents.prompts.shared import GROUNDING_POLICY
from pinai_agents.shared.api_models import (
    CardEvaluation,
    CardsList,
    EvalReport,
    GeneratorOutput,
    PlanItem,
    PlanOutput,
)

_SDK_CLIENT_PY = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "pinai_sdk"
    / "src"
    / "pinai_sdk"
    / "_client.py"
)


def test_generator_runtime_caps_langgraph_recursion():
    source = inspect.getsource(run_generator)

    assert '"recursion_limit": 50' in inspect.getsource(run_generator.__globals__["_stage_config"])
    assert "subagents=[" not in source
    assert "build_generation_context" in source
    assert "create_deep_agent" not in source


def test_source_index_compacts_phase1_sources_for_planner_and_bundles():
    phase1 = {
        "profile": {
            "display_name": "Xing",
            "summary": "Builds proactive AI systems.",
            "facts": {"role": "founder", "long": "x" * 2000},
        },
        "signals": [
            {
                "id": "sig_ci_failed",
                "title": "Deploy Dev failed",
                "summary": "CI failed on proactive-ai-v3.",
                "occurred_at": "2026-06-04T04:56:00Z",
                "payload": {"salience": 0.91, "body": "y" * 2000},
            }
        ],
        "gmail": [
            {
                "id": "raw_gmail_1",
                "subject": "Run failed: Deploy Dev",
                "snippet": "Some jobs were not successful.",
                "received_at": "2026-06-04T04:56:00Z",
                "body": "z" * 2000,
            }
        ],
        "connected_raw": {
            "slack/messages": [
                {
                    "id": "raw_slack_1",
                    "text": "Boliang asked for the generation runtime plan.",
                    "ts": "2026-06-04T09:00:00Z",
                }
            ]
        },
        "goals": [
            {
                "id": "goal_generation_quality",
                "title": "Improve card generation quality",
                "summary": "Generated cards should be grounded and useful.",
            }
        ],
    }

    index = _build_source_index(phase1)
    by_id = {item["id"]: item for item in index}

    assert by_id["sig_ci_failed"]["source_type"] == "signal"
    assert by_id["sig_ci_failed"]["citation"].startswith("signal id=sig_ci_failed")
    assert by_id["raw_gmail_1"]["source_type"] == "gmail"
    assert by_id["raw_slack_1"]["source_type"] == "slack/messages"
    assert by_id["goal_generation_quality"]["source_type"] == "goal"
    assert len(by_id["raw_gmail_1"]["payload"]) < 900

    compact = _compact_phase1_for_planner(phase1, index)
    assert "sources" in compact
    assert compact["goals"][0]["id"] == "goal_generation_quality"
    assert "connected_raw" not in compact
    assert len(str(compact)) < len(str(phase1))

    plan_item = PlanItem(
        intent_key="deploy-dev-failed",
        goal_basket="work",
        decision="Open the failing CI run and inspect the failed job.",
        why_now_trigger="Deploy Dev failed on 2026-06-04.",
        primary_source_ids=["sig_ci_failed"],
        pattern_id=None,
    )
    bundle = _source_bundle_for_plan_item(
        plan_item=plan_item,
        source_index=index,
        compact_phase1=compact,
        matched_patterns=[],
    )
    bundle_ids = {item["id"] for item in bundle["sources"]}
    assert "sig_ci_failed" in bundle_ids
    assert "raw_gmail_1" in bundle_ids


def test_compact_phase1_keeps_recent_card_summary_for_semantic_dedup():
    phase1 = {
        "cards_recent": [
            {
                "id": "run_card_00",
                "intentKey": "hsbc-hk-security-check",
                "goalBasket": "wealth",
                "title": "HSBC HK 新设备注册+跨境限额调至100万港元",
                "whyNow": "The bank alert arrived today.",
                "summary": "Confirm whether the new device and transfer limit change were authorized.",
                "sources": [
                    "signal id=sig_hsbc_device, title=HSBC HK new device",
                    "gmail message id=raw_hsbc, subject=Limit changed",
                    "memory id=mem_bank, text=User banks with HSBC HK",
                    "extra source that should be trimmed",
                ],
            }
        ]
    }

    compact = _compact_phase1_for_planner(phase1, [])
    recent = compact["cards_recent"][0]

    assert recent["intentKey"] == "hsbc-hk-security-check"
    assert "新设备" in recent["title"]
    assert "Confirm whether" in recent["summary"]
    assert len(recent["sources"]) == 2


def test_topup_planner_receives_existing_card_summaries():
    build_context = getattr(generator_module, "_existing_card_context", None)
    assert build_context is not None

    context = build_context(
        compact_phase1={
            "cards_recent": [
                {
                    "intentKey": "existing-hsbc-card",
                    "title": "HSBC HK 新设备注册",
                    "summary": "Confirm whether this was authorized.",
                }
            ]
        },
        generated_cards=[
            _test_card("candidate-hsbc-v2", title="HSBC HK 新设备注册 v2"),
        ],
    )

    assert "recent_cards" in context
    assert "current_candidates" in context
    assert context["current_candidates"][0]["intent_key"] == "candidate-hsbc-v2"


def test_topup_phase1_uses_smaller_source_window():
    build_topup = getattr(generator_module, "_compact_phase1_for_topup", None)
    assert build_topup is not None

    compact = {
        "sources": [{"id": f"source-{idx}"} for idx in range(80)],
        "cards_recent": [{"intentKey": f"recent-{idx}"} for idx in range(20)],
        "profile": {"summary": "x"},
    }

    topup = build_topup(compact)

    assert len(topup["sources"]) == 40
    assert len(topup["cards_recent"]) == 12
    assert topup["profile"] == {"summary": "x"}


def test_connector_guidance_filter_late_phase_drops_active_recent_and_rejected_then_caps_to_one():
    # Late phase: ALL high-value connectors already ACTIVE, so the conservative
    # recent-skip applies again (a recently-shown connector is NOT re-surfaced).
    filter_items = getattr(generator_module, "_filter_connector_guidance_plan_items", None)
    assert filter_items is not None

    items = [
        PlanItem(
            intent_key="connect:gmail",
            goal_basket="work",
            decision="Connect Gmail.",
            why_now_trigger="Email context would help.",
        ),
        PlanItem(
            intent_key="connect:youtube",
            goal_basket="growth",
            decision="Connect YouTube.",
            why_now_trigger="Video context would help.",
        ),
        PlanItem(
            intent_key="connect:calendly",
            goal_basket="work",
            decision="Connect Calendly.",
            why_now_trigger="Scheduling context would help.",
        ),
        PlanItem(
            intent_key="connect:linkedin",
            goal_basket="growth",
            decision="Connect LinkedIn.",
            why_now_trigger="Network context would help.",
        ),
        PlanItem(
            intent_key="connect:stripe",
            goal_basket="wealth",
            decision="Connect Stripe.",
            why_now_trigger="Revenue context would help.",
        ),
        PlanItem(
            intent_key="regular-work-card",
            goal_basket="work",
            decision="Review the real work item.",
            why_now_trigger="A real signal changed today.",
        ),
    ]
    compact_phase1 = {
        # All five high-value connectors linked → late phase.
        "connections_summary": [
            {"toolkit": "gmail", "status": "ACTIVE"},
            {"toolkit": "google_calendar", "status": "ACTIVE"},
            {"toolkit": "slack", "status": "ACTIVE"},
            {"toolkit": "github", "status": "ACTIVE"},
            {"toolkit": "google_drive", "status": "ACTIVE"},
        ],
        "cards_recent": [
            {"intentKey": "connect:youtube", "latestOutcome": None},
        ],
        "feedback": [
            {"intentKey": "connect:calendly", "action": "dismiss"},
        ],
    }

    filtered = filter_items(items, compact_phase1=compact_phase1)

    # gmail dropped (ACTIVE), youtube dropped (recent, late phase), calendly
    # dropped (rejected); linkedin kept (count→1), stripe capped, regular kept.
    assert [item.intent_key for item in filtered] == [
        "connect:linkedin",
        "regular-work-card",
    ]


def test_connector_guidance_filter_early_phase_resurfaces_recent_connector():
    # Early phase: fewer than 3 high-value connectors ACTIVE, so a connector
    # already shown in cards_recent is NOT suppressed — it is re-surfaced to
    # keep one nudge present every run. Active + rejected + cap-1 still hold.
    filter_items = getattr(generator_module, "_filter_connector_guidance_plan_items", None)
    assert filter_items is not None

    items = [
        PlanItem(
            intent_key="connect:gmail",
            goal_basket="work",
            decision="Connect Gmail.",
            why_now_trigger="Email context would help.",
        ),
        PlanItem(
            intent_key="connect:google_calendar",
            goal_basket="work",
            decision="Connect Calendar.",
            why_now_trigger="Meeting context would help.",
        ),
        PlanItem(
            intent_key="connect:youtube",
            goal_basket="growth",
            decision="Connect YouTube.",
            why_now_trigger="Video context would help.",
        ),
        PlanItem(
            intent_key="regular-work-card",
            goal_basket="work",
            decision="Review the real work item.",
            why_now_trigger="A real signal changed today.",
        ),
    ]
    compact_phase1 = {
        # Only gmail ACTIVE → 1 high-value connector → early phase.
        "connections_summary": [
            {"toolkit": "gmail", "status": "ACTIVE"},
        ],
        # google_calendar was shown recently; in early phase it is NOT skipped.
        "cards_recent": [
            {"intentKey": "connect:google_calendar", "latestOutcome": None},
        ],
        "feedback": [
            {"intentKey": "connect:youtube", "action": "dismiss"},
        ],
    }

    filtered = filter_items(items, compact_phase1=compact_phase1)

    # gmail dropped (ACTIVE), youtube dropped (rejected); google_calendar is
    # re-surfaced despite being recent; cap-1 keeps only the first connector.
    assert [item.intent_key for item in filtered] == [
        "connect:google_calendar",
        "regular-work-card",
    ]


def test_connector_guidance_filter_blocks_topup_when_one_already_exists():
    filter_items = getattr(generator_module, "_filter_connector_guidance_plan_items", None)
    assert filter_items is not None

    items = [
        PlanItem(
            intent_key="connect:stripe",
            goal_basket="wealth",
            decision="Connect Stripe.",
            why_now_trigger="Revenue context would help.",
        ),
        PlanItem(
            intent_key="regular-wealth-card",
            goal_basket="wealth",
            decision="Review the revenue signal.",
            why_now_trigger="A real source changed today.",
        ),
    ]

    filtered = filter_items(
        items,
        compact_phase1={"connections_summary": [], "cards_recent": [], "feedback": []},
        existing_intent_keys=["connect:slack"],
    )

    assert [item.intent_key for item in filtered] == ["regular-wealth-card"]


def test_card_writer_content_uses_source_bundle_not_full_phase1():
    plan_item = PlanItem(
        intent_key="deploy-dev-failed",
        goal_basket="work",
        decision="Open the failing CI run and inspect the failed job.",
        why_now_trigger="Deploy Dev failed on 2026-06-04.",
        primary_source_ids=["sig_ci_failed"],
        pattern_id=None,
    )
    source_bundle = {
        "sources": [
            {
                "id": "sig_ci_failed",
                "source_type": "signal",
                "title": "Deploy Dev failed",
                "snippet": "Some jobs were not successful.",
                "citation": "signal id=sig_ci_failed, title=Deploy Dev failed",
                "payload": "{}",
            }
        ],
        "profile": {"summary": "Builds proactive AI systems."},
        "preferences": [],
        "cards_recent": [],
    }

    content = _card_writer_content(
        plan_item=plan_item,
        source_bundle=source_bundle,
        current_date="2026-06-04",
        output_language="zh-Hans",
    )

    assert "<source_bundle_json>" in content
    assert "<phase1_json>" not in content
    assert "sig_ci_failed" in content


def test_planner_prompt_has_preference_alignment():
    prompt = _PLANNER_PROMPT.lower()
    # Anchor keywords for the alignment section.
    assert "preference" in prompt
    assert "positive" in prompt
    assert "negative" in prompt
    assert "durability" in prompt
    assert "expires_at" in prompt
    assert "newest" in prompt
    # Hard-constraint framing — preferences are not just a hint.
    assert "hard constraint" in prompt
    # The planner must surface which preference shaped a plan item.
    assert "notes" in prompt


def test_generator_prompts_preserve_ambient_speaker_attribution():
    planner = _PLANNER_PROMPT.lower()
    card_generator = _CARD_GENERATOR_PROMPT.lower()
    evaluator = _EVALUATOR_PROMPT.lower()
    grounding = GROUNDING_POLICY.lower()

    assert "payload.self_text" in planner
    assert "`self:` lines" in planner
    assert "non-self speech" in planner
    assert 'do not write "you said"' in card_generator
    assert "attributes" in evaluator
    assert "non-self speaker text to the user" in evaluator
    assert "payload.self_text" in grounding
    assert "never attribute non-self speech to the user" in grounding


def test_planner_prompt_has_scheduled_generation_request_input():
    prompt = _PLANNER_PROMPT.lower()

    assert "generation_request" in prompt
    assert "confirmed_brief" in prompt
    assert "parsed_intent" in prompt


def test_sdk_exposes_preferences_list():
    """Load the SDK source directly (the wheel isn't installed in the
    agents test env, same constraint as test_sdk_cheat_sheet_sync) and
    assert the client surface agent code depends on still exists."""
    spec = importlib.util.spec_from_file_location("pinai_sdk_client", _SDK_CLIENT_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    client = module.client
    assert hasattr(client, "preferences")
    assert callable(client.preferences.list)
    assert callable(client.preferences.add)
    assert callable(client.preferences.supersede)
    assert callable(client.profile.merge_preference)
    # Language is a deterministic setting, not a preference.
    assert hasattr(client, "settings")
    assert callable(client.settings.set_generation_language)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (
            PlanOutput,
            {
                "plan": [],
                "notes": "phase1 has usable sources but planner returned nothing",
            },
        ),
        (
            CardsList,
            {
                "cards": [],
            },
        ),
        (
            EvalReport,
            {
                "evaluations": [],
                "batchFeedback": "card-generator produced cards but evaluator returned nothing",
            },
        ),
        (
            GeneratorOutput,
            {
                "reasoning": "phase1 had usable sources but fixed pipeline returned no cards",
                "cards": [],
                "evaluations": [],
                "batchFeedback": "empty result",
            },
        ),
    ],
)
def test_generator_structured_outputs_allow_empty_error_shells(model, payload):
    """Empty structured outputs are valid error/no-grounding shells; the
    HTTP route rejects them before persistence."""
    assert model.model_validate(payload)


def test_card_evaluation_allows_long_single_card_feedback():
    assert CardEvaluation(
        intentKey="long-feedback-card",
        relevance=8,
        actionability=8,
        whyNowClarity=8,
        novelty=8,
        decisionCompression=8,
        overall=8,
        pass_=True,
        feedback="grounding detail " * 350,
    )


def _test_card(intent_key: str, *, basket: str = "work", title: str | None = None):
    from pinai_agents.shared.api_models import CardAction, GeneratedCard

    return GeneratedCard(
        intentKey=intent_key,
        goalBasket=basket,
        title=title or f"{intent_key} title",
        whyNow="A concrete source changed today.",
        summary="This card compresses a real decision.",
        primaryAction=CardAction(label="Review", type="confirm", agentPrompt="Review this item."),
        confidence=0.8,
        urgency=0.7,
        importance=0.8,
        sources=[f"signal id={intent_key}, title={intent_key}"],
    )


def _test_eval(intent_key: str, *, passed: bool, overall: float) -> CardEvaluation:
    return CardEvaluation(
        intentKey=intent_key,
        relevance=overall,
        actionability=overall,
        whyNowClarity=overall,
        novelty=overall,
        decisionCompression=overall,
        overall=overall,
        pass_=passed,
        feedback="short rationale",
    )


def test_final_selection_prefers_judge_order_then_fills_with_ranked_cards():
    selection_model = getattr(generator_module, "FinalSelection", None)
    assert selection_model is not None
    apply_selection = getattr(generator_module, "_apply_final_selection", None)
    assert apply_selection is not None

    cards = [
        _test_card("steady-high", basket="work"),
        _test_card("editor-pick", basket="wealth"),
        _test_card("failed-low", basket="life"),
    ]
    evaluations = [
        _test_eval("steady-high", passed=True, overall=8.0),
        _test_eval("editor-pick", passed=True, overall=7.0),
        _test_eval("failed-low", passed=False, overall=4.0),
    ]
    selection = selection_model(
        selectedIntentKeys=["editor-pick"],
        rejectedIntentKeys=["failed-low"],
        notes="editor-pick has the clearest user-facing decision",
    )

    selected = apply_selection(
        cards=cards,
        evaluations=evaluations,
        selection=selection,
        limit=2,
    )

    assert [card.intent_key for card in selected] == ["editor-pick", "steady-high"]


def test_usable_unique_card_count_ignores_duplicate_passing_evals():
    count_usable = getattr(generator_module, "_usable_unique_card_count", None)
    assert count_usable is not None

    cards = [
        _test_card("same-decision", basket="work", title="First angle"),
        _test_card("same-decision", basket="work", title="Duplicate angle"),
        _test_card("second-decision", basket="wealth"),
        _test_card("failed-decision", basket="life"),
    ]
    evaluations = [
        _test_eval("same-decision", passed=True, overall=8.0),
        _test_eval("same-decision", passed=True, overall=7.0),
        _test_eval("second-decision", passed=True, overall=7.5),
        _test_eval("failed-decision", passed=False, overall=6.5),
    ]

    assert count_usable(cards, evaluations) == 2


def test_final_selection_content_uses_card_eval_summaries_not_full_phase1():
    build_content = getattr(generator_module, "_final_selection_content", None)
    assert build_content is not None

    content = build_content(
        cards=[_test_card("quality-card", title="Ship 8-card generation report")],
        evaluations=[_test_eval("quality-card", passed=True, overall=8.2)],
        limit=8,
        current_date="2026-06-04",
    )

    assert "Ship 8-card generation report" in content
    assert "overall" in content
    assert "<phase1_json>" not in content
    assert "<source_bundle_json>" not in content


def test_final_selection_content_stays_compact_for_many_candidates():
    build_content = getattr(generator_module, "_final_selection_content", None)
    assert build_content is not None

    cards = []
    for idx in range(24):
        card = _test_card(
            f"candidate-{idx}",
            title=f"Candidate {idx} with enough detail to compare",
        )
        cards.append(
            card.model_copy(
                update={
                    "summary": "Long generated card summary. " * 60,
                    "sources": [
                        "signal id=sig_long, title=" + ("long source " * 40),
                        "gmail message id=raw_long, subject=" + ("long source " * 40),
                        "memory id=mem_long, text=" + ("long source " * 40),
                    ],
                }
            )
        )
    evaluations = [
        _test_eval(
            f"candidate-{idx}",
            passed=idx < 8,
            overall=8.0 - (idx * 0.05),
        ).model_copy(update={"feedback": "Long evaluator feedback. " * 60})
        for idx in range(24)
    ]

    content = build_content(
        cards=cards,
        evaluations=evaluations,
        limit=8,
        current_date="2026-06-04",
    )

    assert len(content) < 16_000


def test_run_generator_has_topup_and_final_selection_stages():
    source = inspect.getsource(run_generator)

    assert getattr(generator_module, "_MAX_TOPUP_ROUNDS", None) == 2
    assert 'stage_suffix = "" if topup_round == 1 else str(topup_round)' in source
    assert 'planner_stage = f"topup{stage_suffix}_planner"' in source
    assert "final_selection" in source


def test_run_generator_threads_focus_into_planner_content():
    """Chat-triggered generation plumbing: an optional `focus` topic is
    threaded into the planner content as a hard "USER FOCUS" directive,
    only when present. Whether the planner actually centers candidates on
    the focus is an LLM behavior, verified manually against a LangSmith
    trace (same convention as the preference-alignment plumbing above)."""
    sig = inspect.signature(run_generator)
    focus_param = sig.parameters.get("focus")
    assert focus_param is not None, "run_generator must accept a `focus` kwarg"
    assert focus_param.default is None, "focus must be optional (default None)"

    source = inspect.getsource(run_generator)
    # The directive is injected into the planner content, gated on `focus`.
    assert "USER FOCUS" in source
    assert "if focus" in source
    # And the value actually interpolates the caller-supplied focus string.
    assert "{focus}" in source


# ── connector intent_key canonicalization + final-slot reservation ──────────
# The planner/writer/evaluator routinely slugify "connect:slack" into
# "connect-slack"; every connector code path keys off the "connect:" prefix, so
# the malformed key silently degrades the card. These assert the boundary
# normalization and the reserved final slot that keep one connector nudge alive.


def test_canonicalize_connector_intent_key_rewrites_dash_forms_only_for_real_connectors():
    canon = generator_module._canonicalize_connector_intent_key
    assert canon("connect-slack") == "connect:slack"
    assert canon("connect_slack") == "connect:slack"
    assert canon("connect-google-calendar") == "connect:google_calendar"
    assert canon("connect-gcal") == "connect:google_calendar"
    assert canon("connect-googledrive") == "connect:google_drive"
    assert canon("connect:slack") == "connect:slack"  # already canonical → no-op
    # non-connector keys (and unknown slugs) are left untouched
    assert canon("connect-the-dots") == "connect-the-dots"
    assert canon("rsu-vest-june-15-plan") == "rsu-vest-june-15-plan"
    assert canon(None) is None


def test_filter_canonicalizes_dash_connector_keys_in_place():
    filter_items = generator_module._filter_connector_guidance_plan_items
    # Slack ACTIVE: a dash-form "connect-slack" must be recognized and dropped —
    # only possible once it is canonicalized to "connect:slack".
    items = [
        PlanItem(
            intent_key="connect-slack",
            goal_basket="work",
            decision="Connect Slack.",
            why_now_trigger="Slack context would help.",
        ),
        PlanItem(
            intent_key="regular-work-card",
            goal_basket="work",
            decision="Review the real work item.",
            why_now_trigger="A real signal changed today.",
        ),
    ]
    all_active = {
        "connections_summary": [
            {"toolkit": s, "status": "ACTIVE"}
            for s in ("gmail", "google_calendar", "slack", "github", "google_drive")
        ],
    }
    assert [i.intent_key for i in filter_items(items, compact_phase1=all_active)] == [
        "regular-work-card",
    ]
    # When kept (slack NOT active), the surviving plan item carries the
    # canonical key so the downstream writer/frontend recognize it.
    kept = filter_items(
        [
            PlanItem(
                intent_key="connect-slack",
                goal_basket="work",
                decision="Connect Slack.",
                why_now_trigger="Slack context would help.",
            )
        ],
        compact_phase1={"connections_summary": [{"toolkit": "gmail", "status": "ACTIVE"}]},
    )
    assert [i.intent_key for i in kept] == ["connect:slack"]


def test_ensure_connector_card_present_reserves_a_slot():
    ensure = generator_module._ensure_connector_card_present
    content = [SimpleNamespace(intent_key=f"work-{i}") for i in range(3)]
    connector = SimpleNamespace(intent_key="connect:slack")
    evals = [
        SimpleNamespace(intent_key="work-0", pass_=True, overall=8.8),
        SimpleNamespace(intent_key="work-1", pass_=True, overall=8.6),
        SimpleNamespace(intent_key="work-2", pass_=True, overall=8.4),
        SimpleNamespace(intent_key="connect:slack", pass_=True, overall=8.3),
    ]
    # connector was out-ranked and cut from the top-3
    result = ensure(
        ranked=list(content), all_cards=content + [connector], evaluations=evals, limit=3
    )
    keys = [c.intent_key for c in result]
    assert "connect:slack" in keys
    assert len(result) == 3
    assert "work-2" not in keys  # lowest-ranked content card swapped out


def test_ensure_connector_card_present_noops():
    ensure = generator_module._ensure_connector_card_present
    # already present → returns the same list untouched
    connector = SimpleNamespace(intent_key="connect:slack")
    ranked = [connector, SimpleNamespace(intent_key="work-0")]
    evals = [SimpleNamespace(intent_key="connect:slack", pass_=True, overall=8.3)]
    assert ensure(ranked=ranked, all_cards=ranked, evaluations=evals, limit=2) is ranked
    # connector failed eval → not injected
    content = [SimpleNamespace(intent_key="work-0"), SimpleNamespace(intent_key="work-1")]
    failed = [SimpleNamespace(intent_key="connect:slack", pass_=False, overall=4.0)]
    result = ensure(
        ranked=content,
        all_cards=content + [SimpleNamespace(intent_key="connect:slack")],
        evaluations=failed,
        limit=2,
    )
    assert [c.intent_key for c in result] == ["work-0", "work-1"]
