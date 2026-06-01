from __future__ import annotations

import pytest
from pydantic import ValidationError

from pinai_agents.chat.routes.generate import GenerateRequest as ChatGenerateRequest
from pinai_agents.shared.api_models import GenerateRequest


@pytest.mark.parametrize(
    ("model", "payload_key"),
    [
        (GenerateRequest, "cardsToGenerate"),
        (ChatGenerateRequest, "cards_to_generate"),
    ],
)
def test_generate_request_accepts_default_and_valid_integer(
    model: type,
    payload_key: str,
) -> None:
    assert model().cards_to_generate == 8
    assert model.model_validate({payload_key: 5}).cards_to_generate == 5


@pytest.mark.parametrize("value", [True, False, "5", 5.0, 0, 11])
@pytest.mark.parametrize(
    ("model", "payload_key"),
    [
        (GenerateRequest, "cardsToGenerate"),
        (ChatGenerateRequest, "cards_to_generate"),
    ],
)
def test_generate_request_rejects_implicit_or_out_of_range_counts(
    model: type,
    payload_key: str,
    value: object,
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate({payload_key: value})
