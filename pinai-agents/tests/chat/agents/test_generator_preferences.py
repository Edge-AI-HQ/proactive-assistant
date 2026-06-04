"""Goal 2 plumbing: active preferences reach generation.

These are plumbing assertions only — that the data-collector pulls
preferences into the phase1 digest, that the planner prompt carries the
preference-alignment instruction, and that the SDK exposes the method the
script calls. Whether the planner actually biases toward a preference is
an LLM behavior, verified manually against a LangSmith trace (out of the
loop), never asserted here.
"""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

import pytest

from pinai_agents.chat.agents.generator import (
    _CARD_GENERATOR_PROMPT,
    _DATA_COLLECTOR_PROMPT,
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


def test_data_collector_pulls_preferences_into_digest():
    # The canonical script calls the SDK preferences endpoint ...
    assert "client.preferences.list" in _DATA_COLLECTOR_PROMPT
    # ... and stages it under the 'preferences' digest key for downstream
    # subagents to read out of /state/phase1.json.
    assert '"preferences"' in _DATA_COLLECTOR_PROMPT


def test_data_collector_pulls_full_ambient_signal_details_into_digest():
    assert "ambient_signal_details" in _DATA_COLLECTOR_PROMPT
    assert 's.get("kind") == "ambient.candidate_window"' in _DATA_COLLECTOR_PROMPT
    assert "client.signals.get(signal_id)" in _DATA_COLLECTOR_PROMPT


def test_data_collector_pulls_connected_raw_sources_into_digest():
    assert "client.composio.connections()" in _DATA_COLLECTOR_PROMPT
    assert "RAW_SOURCE_BY_TOOLKIT" in _DATA_COLLECTOR_PROMPT
    assert '"slack": ("slack", "messages")' in _DATA_COLLECTOR_PROMPT
    assert '"googledrive": ("gdrive", "files")' in _DATA_COLLECTOR_PROMPT
    assert 'client.raw.list(toolkit, entity, hours=24, limit=20)' in _DATA_COLLECTOR_PROMPT
    assert "client.raw.list(toolkit, entity, hours=24, limit=80)" not in _DATA_COLLECTOR_PROMPT
    assert '"connected_raw"' in _DATA_COLLECTOR_PROMPT


def test_generator_runtime_caps_langgraph_recursion():
    source = inspect.getsource(run_generator)

    assert '"recursion_limit": 50' in inspect.getsource(run_generator.__globals__["_stage_config"])
    assert "subagents=[" not in source


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
    }

    index = _build_source_index(phase1)
    by_id = {item["id"]: item for item in index}

    assert by_id["sig_ci_failed"]["source_type"] == "signal"
    assert by_id["sig_ci_failed"]["citation"].startswith("signal id=sig_ci_failed")
    assert by_id["raw_gmail_1"]["source_type"] == "gmail"
    assert by_id["raw_slack_1"]["source_type"] == "slack/messages"
    assert len(by_id["raw_gmail_1"]["payload"]) < 900

    compact = _compact_phase1_for_planner(phase1, index)
    assert "sources" in compact
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


def test_sdk_exposes_preferences_list():
    """Load the SDK source directly (the wheel isn't installed in the
    agents test env, same constraint as test_sdk_cheat_sheet_sync) and
    assert the client surface the data-collector script depends on
    actually exists."""
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
