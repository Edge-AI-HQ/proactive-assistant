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
    run_generator,
)
from pinai_agents.chat.agents.prompts.shared import GROUNDING_POLICY
from pinai_agents.shared.api_models import CardsList, EvalReport, GeneratorOutput, PlanOutput

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

    assert '"recursion_limit": 80' in source


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
                "reasoning": "phase1 had usable sources but orchestrator returned no cards",
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
