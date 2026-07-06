"""build_portrait — immutable AGENTS safety constant (first) + five trusted slots.

The portrait assembly is the chat agent's resident L2 view: AGENTS is a hard
constant that outranks everything below it; all five DB slots (IDENTITY/SOUL/
TOOLS + USER/GOALS) are trusted content the agent maintains — no <untrusted-text>
wrapper. The AGENTS block is the single injection boundary.
"""

from __future__ import annotations

import pytest
from agent_engine.agents.prompts.portrait import build_portrait
from agent_engine.harness.middleware import PortraitMiddleware
from agent_engine.tools import http_client


def test_empty_portrait_is_agent_constant_only():
    """slots={} means the portrait FETCH FAILED — degrade to the AGENTS
    constant alone (no sections), never claim the slots are empty."""
    p = build_portrait({})
    assert "<agent_safety>" in p  # AGENTS safety constant always present
    assert "## USER" not in p  # failed fetch → constant only, no sections
    assert "<untrusted-text>" not in p  # the wrapper is gone entirely


def test_all_five_slots_are_trusted_no_untrusted_wrapper():
    p = build_portrait(
        {"IDENTITY": "playful tone please", "SOUL": "warm", "USER": "founder @ PIN AI"}
    )
    # No untrusted wrapper anymore — every slot is trusted content the agent
    # can edit, including its own persona (IDENTITY/SOUL/TOOLS). Each section
    # header carries its one-line definition (read-side slot semantics).
    assert "<untrusted-text>" not in p
    assert "## IDENTITY — who you are to this user\nplayful tone please" in p
    assert "## SOUL — your personality and voice\nwarm" in p
    assert "## USER — durable facts and preferences about the user\nfounder @ PIN AI" in p


def test_fetched_portrait_renders_all_slots_with_semantics():
    """A successful fetch returns all five keys (some empty): every section
    renders with its definition, and an empty slot carries the placeholder so
    the agent still sees the dimension exists (vs the failed-fetch case above,
    which renders no sections at all)."""
    p = build_portrait({"IDENTITY": "", "SOUL": "", "USER": "founder", "TOOLS": "", "GOALS": ""})
    # TOOLS semantics disambiguated in the header: how the agent should use
    # tools for this user — not the user's own app inventory.
    assert "## TOOLS — how the user wants you to use your tools" in p
    assert "not an inventory of the user's apps" in p
    assert p.count("(empty — nothing durable recorded yet; write via memory_edit)") == 4
    assert "## USER — durable facts and preferences about the user\nfounder" in p


def test_agent_constant_comes_first():
    p = build_portrait({"USER": "founder", "IDENTITY": "concise"})
    # The safety constant outranks (precedes) every editable slot.
    assert p.index("<agent_safety>") < p.index("## IDENTITY")
    assert p.index("<agent_safety>") < p.index("## USER")


def test_slot_order_is_fixed_for_cache_stability():
    # Fixed injection order IDENTITY < SOUL < USER < TOOLS < GOALS (design §六:
    # persona → user view → tools → goals) regardless of input dict order. The
    # key contract is TOOLS lands AFTER USER, not grouped with IDENTITY/SOUL.
    p = build_portrait(
        {
            "GOALS": "ship",
            "TOOLS": "prefers CLI",
            "USER": "founder",
            "SOUL": "warm",
            "IDENTITY": "concise",
        }
    )
    assert (
        p.index("## IDENTITY")
        < p.index("## SOUL")
        < p.index("## USER")
        < p.index("## TOOLS")
        < p.index("## GOALS")
    )


@pytest.mark.asyncio
async def test_portrait_middleware_fetches_with_trailing_slash(monkeypatch):
    """The route is mounted at /api/agent/user-strings/ — WITHOUT the trailing
    slash FastAPI 307-redirects and httpx (no auto-follow) hands back an empty
    body → JSONDecodeError that kills the chat turn. Regression guard for that
    exact bug."""
    calls: list[str] = []

    async def fake_get(path, **params):
        calls.append(path)
        return {"slots": {"USER": "founder @ PIN AI"}}

    monkeypatch.setattr(http_client, "get", fake_get)
    msg = await PortraitMiddleware()._portrait_message()
    assert calls == ["/api/agent/user-strings/"]
    assert msg is not None
    assert "founder @ PIN AI" in msg.content


@pytest.mark.asyncio
async def test_portrait_middleware_degrades_when_fetch_fails(monkeypatch):
    """A failed portrait fetch must not kill the chat turn — it falls back to
    build_portrait({}), i.e. the AGENTS safety constant only (no user slots)."""

    async def boom(path, **params):
        raise RuntimeError("api unreachable")

    monkeypatch.setattr(http_client, "get", boom)
    msg = await PortraitMiddleware()._portrait_message()
    assert msg is not None  # did not raise
    assert "<agent_safety>" in msg.content  # safety constant preserved
