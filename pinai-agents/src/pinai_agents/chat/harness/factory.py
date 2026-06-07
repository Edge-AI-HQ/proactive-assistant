"""Agent construction facade.

The ONLY place outside this `harness/` package that calls deepagents'
`create_deep_agent`. Business modules in `agents/*.py` declare their spec
(system prompt + tool set + subagents + whether the thread is persistent)
and call `build_agent()`; they never import deepagents directly. This keeps
the framework dependency in one swappable layer (plan 2026-06-02 §PR-C) and
lets ruff's banned-api forbid `deepagents` / `langgraph` imports everywhere
except `harness/`.

`BackendProtocol` and `SubAgent` are re-exported here so business modules
can type their backends / subagent rosters without importing deepagents.
`create_deep_agent` is also re-exported for `agents/generator.py`, whose
multi-subagent orchestration (data_collector → planner → card_generator →
evaluator under an orchestrator, each with its own response_format) is too
bespoke for `build_agent`; it composes the graph itself but routes the
import through here so the deepagents dependency stays inside `harness/`.
"""

from __future__ import annotations

from typing import Any

from deepagents import SubAgent, create_deep_agent
from deepagents.backends.protocol import BackendProtocol

from .checkpoint import get_checkpointer

__all__ = ["BackendProtocol", "SubAgent", "build_agent", "create_deep_agent"]


def build_agent(
    *,
    model: Any,
    system_prompt: str,
    backend: BackendProtocol,
    tools: list[Any] | None = None,
    subagents: list[SubAgent] | None = None,
    interrupt_on: dict[str, Any] | None = None,
    with_checkpointer: bool = False,
) -> Any:
    """Wrap `create_deep_agent` with the business spec.

    `model` is built by the caller via `harness.llm.make_chat_model` (model
    tier / thinking budget / streaming are business choices). `with_checkpointer`
    is opt-in: only the persistent main + card chat threads checkpoint; the
    one-shot batch agents (crystallize / evolve / dream / generator) don't.
    `interrupt_on` maps side-effect tool names → HITL gate: deepagents wires
    `HumanInTheLoopMiddleware`, so the run pauses on langgraph `interrupt()`
    BEFORE the tool runs; web translates that into a requires_action frame and
    resumes with `Command(resume=)` once a decision arrives. deepagents'
    default middleware stack (todo / fs / subagent / summarization /
    prompt-caching) is applied by create_deep_agent itself.
    """
    kwargs: dict[str, Any] = {}
    if tools is not None:
        kwargs["tools"] = tools
    if subagents:
        kwargs["subagents"] = subagents
    if interrupt_on:
        kwargs["interrupt_on"] = interrupt_on
    if with_checkpointer:
        kwargs["checkpointer"] = get_checkpointer()
    return create_deep_agent(
        model=model,
        system_prompt=system_prompt,
        backend=backend,
        **kwargs,
    )
