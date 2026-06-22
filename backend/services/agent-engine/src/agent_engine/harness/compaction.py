"""Bounded agent context — token/message-triggered LLM compaction.

A persistent thread (main chat is a singleton; proactive is a never-ending
heartbeat) can't keep every message live: the prompt grows unbounded (per-turn
cost + latency, eventually the context window) and the checkpoint blob grows
with it.

`compact_thread` is the single maintenance pass, run best-effort after a turn:

  * TRIGGER — reported input tokens cross `token_trigger`, OR the message count
    crosses `message_trigger` (a belt-and-suspenders bound when token accounting
    is unavailable). Same pass for main + proactive.
  * COMPACT — the older turns are summarized by an LLM into one message; the most
    recent `keep_recent_turns` user-turns are kept verbatim.
  * WRITE-BACK — `RemoveMessage(REMOVE_ALL_MESSAGES)` + `[summary, *tail]` via
    `aupdate_state`. This MUTATES `state["messages"]`: the checkpoint physically
    holds only `[summary, *tail]` from here on, so each subsequent checkpoint
    blob is bounded (not the unbounded full history). The model reads the
    compacted state directly — no separate "summary view" needed.

Why this and not the alternatives (all verified by end-to-end test, 2026-06-10):

  * NOT deepagents' built-in summarization — it's non-mutating: it compresses
    only the *view fed to the LLM* and leaves `state["messages"]` at full size,
    so the checkpoint blob still grows without bound (the proactive 5.6 GB
    blow-up was exactly this — the LLM read a compacted view, but storage kept
    the full 400k-token messages). Compacting the LLM view does NOT bound
    storage; mutating the state does.
  * NOT `adelete_thread` + re-seed — adelete drops the ancestor write chain the
    messages DeltaChannel reconstructs from, and the re-seeded checkpoint isn't a
    snapshot, so `aget_state` reconstructs EMPTY (silently). Verified: rows 40→1
    but messages 16→0.
  * NOT a hand-written force-snapshot checkpoint (`aput` a `_DeltaSnapshot`) —
    the snapshot itself reads back fine, but the next real turn fails to append
    on top (the agent loop can't resume cleanly from a hand-built checkpoint).
    Verified: rows→1 + messages correct, but the following turn doesn't land.

REMOVE_ALL bounds the blob SIZE but not the checkpoint ROW count: LangGraph
appends one row per super-step (an append-only history for time-travel /
recovery) and never self-deletes. Storage is bounded by THREAD LIFECYCLE, not by
compaction — main chat's row count is naturally finite (conversations end);
proactive's grows slowly (small blobs now) and is bounded separately by thread
roll-over if it ever matters. This matches LangGraph's design: checkpoints are
short-term per-thread state, long-term memory lives in a Store (our pai_memory).

Nothing is lost to the user: full history lives in pai_chat_messages (display)
and durable facts in pai_memory (recall). The thread is only the agent's
short-term working set. The in-place rewrite is atomic and the control plane serializes
a session's turns, so no concurrent turn observes a half-written window.

`_split_at_turn_boundary` is a pure function (unit-tested for turn-boundary and
tool-call/tool-result pairing safety); the rest applies it through the compiled
agent's state.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    get_buffer_string,
)
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from .llm import make_chat_model

logger = logging.getLogger(__name__)

# Compact once the reported input size crosses this. Claude's window is 200k (1M
# on 4.6+); 150k aligns with Anthropic's own server-side compaction default and
# leaves headroom. Because the window is append-only BETWEEN compactions, the
# Anthropic prompt cache hits turn-over-turn (a per-turn slide would bust it).
DEFAULT_TOKEN_TRIGGER = 150_000

# Belt-and-suspenders: also compact if the raw message count gets large, so a
# thread can't grow unbounded even if token accounting is missing. ~200 messages
# ≈ 100 turns, well above the token trigger's ~75 turns at typical sizes.
DEFAULT_MESSAGE_TRIGGER = 200

# Keep this many most-recent user-turns verbatim after a compaction; older turns
# collapse into one summary message. 12 turns aligns with LangChain's
# summarization keep default (≈20 messages) — enough recent context that a
# compaction doesn't strand the user mid-task.
DEFAULT_KEEP_RECENT_TURNS = 12

# Cap the summary LLM call so a hung provider can't pin the worker (the post-turn
# path is best-effort; see the 2026-06 main-chat provision hang). Generous because
# the summary uses the user's DEFAULT model, which may be a reasoning model (e.g.
# kimi) that ignores enable_thinking and runs slow (~60-70s) — still well under
# the chat read timeout (600s).
_SUMMARY_TIMEOUT_S = 300.0

_SUMMARY_SYSTEM_PROMPT = (
    "You are compacting an ongoing assistant conversation so it fits the "
    "context window. Write a dense, factual summary of the excerpt that "
    "preserves everything needed to continue seamlessly:\n"
    "- the user's intent, decisions, stated preferences, and commitments\n"
    "- task state: what is done, what is pending, open questions\n"
    "- concrete facts surfaced (names, ids, values, paths, tool results)\n"
    "- threads the assistant still needs to follow up on\n"
    "Drop pleasantries and redundant back-and-forth. Third person, compact "
    "prose or bullets, no preamble."
)


def _split_at_turn_boundary(messages: list[Any], *, keep_recent_turns: int) -> int:
    """Index where the kept tail begins: `messages[:i]` are older turns to
    compress, `messages[i:]` is the most recent `keep_recent_turns` user-turns.

    A turn starts at a HumanMessage, so cutting on that boundary guarantees the
    tail opens with a HumanMessage and never orphans a ToolMessage or splits an
    AIMessage's tool_calls from their ToolMessage (the provider rejects a
    dangling tool_use). Returns 0 when there are at most `keep_recent_turns`
    turns — nothing to compress.
    """
    if keep_recent_turns <= 0:
        return len(messages)
    turn_starts = [i for i, m in enumerate(messages) if isinstance(m, HumanMessage)]
    if len(turn_starts) <= keep_recent_turns:
        return 0
    return turn_starts[len(turn_starts) - keep_recent_turns]


def should_attempt_compaction(
    *,
    input_tokens: int | None,
    message_count: int | None,
    token_trigger: int = DEFAULT_TOKEN_TRIGGER,
    message_trigger: int = DEFAULT_MESSAGE_TRIGGER,
) -> bool:
    """Cheap pre-check from stream-observed numbers (TurnStats), deciding
    whether the post-turn pass needs to touch state at all. Mirrors
    `compact_thread`'s trigger. The token side is exact (same provider-reported
    accounting); the message side is observed a few trailing messages early, so
    against the coarse trigger a borderline turn fires one turn later — the
    token trigger, the primary bound, is unaffected. Conservative: when the
    provider attached no usage (`input_tokens` None) we can't rule the token
    trigger out, so fall through to the full check (which has the
    approximate-count fallback).
    """
    if input_tokens is None:
        return True
    if input_tokens > token_trigger:
        return True
    return message_count is not None and message_count > message_trigger


def _reported_input_tokens(messages: list[Any]) -> int:
    """Best estimate of the next turn's input size. Prefers the provider's
    reported usage on the latest AIMessage — exact, and it already counts the
    system prompt + tool schemas + history that `count_tokens_approximately`
    cannot see from the message list alone. Falls back to the approximate count
    when no usage is attached (e.g. a thread whose last write was a compaction).
    """
    for m in reversed(messages):
        if isinstance(m, AIMessage):
            usage = m.usage_metadata
            if usage:
                total = int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
                if total > 0:
                    return total
            break
    return count_tokens_approximately(messages)


def _message_text(message: Any) -> str:
    """Concatenate a message's text, tolerating both bare-string content and
    the v1 content-block list shape `make_chat_model` can emit."""
    content = message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block) for block in content
        )
    return str(content)


def _summary_message(summary_text: str) -> HumanMessage:
    """The single message that replaces the compressed older turns. Tagged
    `lc_source=summarization` so deepagents' own summarization middleware
    recognizes it (no double-offload) and the history reader can mark it."""
    return HumanMessage(
        content=(
            "Earlier turns of this conversation were summarized to save "
            "context. Full history is in the chat log; durable facts are in "
            "memory (use memory_search). Condensed summary:\n\n"
            f"<conversation_summary>\n{summary_text}\n</conversation_summary>"
        ),
        additional_kwargs={"lc_source": "summarization"},
    )


async def _summarize(messages: list[Any], *, virtual_key: str) -> str:
    """LLM-compress `messages` into a summary string. Uses the user's DEFAULT
    model (consistent with their config / billing), non-streaming, thinking off
    (a summary needs none; a reasoning model may ignore this — that's what the
    generous `_SUMMARY_TIMEOUT_S` covers)."""
    model = make_chat_model(
        virtual_key=virtual_key,
        streaming=False,
        enable_thinking=False,
        enable_prompt_cache=False,
    )
    prompt = [
        SystemMessage(content=_SUMMARY_SYSTEM_PROMPT),
        HumanMessage(content=get_buffer_string(messages)),
    ]
    response = await asyncio.wait_for(model.ainvoke(prompt), timeout=_SUMMARY_TIMEOUT_S)
    return _message_text(response).strip()


async def compact_thread(
    agent: Any,
    *,
    thread_id: str,
    virtual_key: str,
    token_trigger: int = DEFAULT_TOKEN_TRIGGER,
    keep_recent_turns: int = DEFAULT_KEEP_RECENT_TURNS,
    message_trigger: int = DEFAULT_MESSAGE_TRIGGER,
) -> int:
    """Maintain a thread's working context. Best-effort, run after a turn.

    Fires when reported input tokens exceed `token_trigger` OR the message count
    exceeds `message_trigger`. Summarizes the older turns and rewrites the window
    in place to `[summary, *tail]` (mutating — the checkpoint then physically
    holds only the compacted window). Returns the number of older messages folded
    into the summary (0 when nothing fired or there was nothing to compress).
    """
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = await agent.aget_state(config)
    messages: list[Any] = (snapshot.values or {}).get("messages", []) if snapshot else []
    if not messages:
        return 0

    over_tokens = _reported_input_tokens(messages) > token_trigger
    over_messages = len(messages) > message_trigger
    if not over_tokens and not over_messages:
        return 0

    cut = _split_at_turn_boundary(messages, keep_recent_turns=keep_recent_turns)
    old, tail = messages[:cut], messages[cut:]
    # Nothing compressible (the kept window already holds every turn) — rewriting
    # would only churn the checkpoint, so skip.
    if not old:
        return 0

    try:
        summary = await _summarize(old, virtual_key=virtual_key)
    except Exception:
        logger.exception("compaction summarize failed thread=%s", thread_id)
        return 0

    await agent.aupdate_state(
        config,
        {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), _summary_message(summary), *tail]},
    )
    logger.info("compacted thread=%s folded=%d kept=%d", thread_id, len(old), len(tail))
    return len(old)


def is_empty_ai_message(message: AIMessage) -> bool:
    """True when the message carries nothing replayable or renderable: no tool
    calls and no non-blank text or non-text block. A reasoning-only message is
    NOT empty — its thinking block still renders in history (the request path
    in harness/llm.py handles its replay). That covers both the v1 reasoning
    content block and the legacy `additional_kwargs.reasoning_content` shape
    persisted by pre-v1 threads (the history reader falls back to it)."""
    if message.tool_calls or message.invalid_tool_calls:
        return False
    if message.additional_kwargs.get("tool_calls") or message.additional_kwargs.get(
        "function_call"
    ):
        return False
    legacy_reasoning = message.additional_kwargs.get("reasoning_content")
    if isinstance(legacy_reasoning, str) and legacy_reasoning.strip():
        return False
    content = message.content
    if isinstance(content, str):
        return not content.strip()
    if isinstance(content, list):
        return all(
            (isinstance(block, str) and not block.strip())
            or (
                isinstance(block, dict)
                and block.get("type") == "text"
                and not str(block.get("text") or "").strip()
            )
            for block in content
        )
    return False


async def scrub_empty_ai_messages(agent: Any, *, thread_id: str) -> int:
    """Physically remove empty AI messages from a thread's checkpoint.

    They appear when the model ends a turn with a 0-token reply — seen on dev
    after propose_action's delivery receipt: finish_reason=stop, content=[].
    The message renders nothing, but once persisted it poisons the thread for
    strict providers: Moonshot rejects the whole request on replay ("the
    message at position N with role 'assistant' must not be empty"), so every
    later turn 400s. The request-path guard in harness/llm.py keeps such
    threads usable; this scrub heals the stored state so the poison doesn't
    accumulate. Cheap (state read + write only when something matched, no
    LLM), runs post-turn for every thread kind, cards included. Returns the
    number of messages removed.
    """
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = await agent.aget_state(config)
    messages: list[Any] = (snapshot.values or {}).get("messages", []) if snapshot else []
    removals = [
        RemoveMessage(id=m.id)
        for m in messages
        if isinstance(m, AIMessage) and m.id and is_empty_ai_message(m)
    ]
    if not removals:
        return 0
    await agent.aupdate_state(config, {"messages": removals})
    logger.info("scrubbed empty AI messages thread=%s removed=%d", thread_id, len(removals))
    return len(removals)
