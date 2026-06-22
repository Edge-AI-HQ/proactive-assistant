"""Parsing helpers for LiteLLM chat-completion HTTP responses.

`platform/litellm/client.py` covers the admin API (create user / key, …);
these two helpers cover the *inference* response shape (`/chat/completions`)
that several domains call directly over HTTP (voice transcription post-edit,
ambient summary, onboarding connector summary). They were copied verbatim
into each caller; this is the single source of truth.
"""

from __future__ import annotations

from typing import Any


def message_content(payload: Any) -> str | None:
    """First choice's `message.content`, or None when the envelope is
    malformed / the content is empty."""
    if not isinstance(payload, dict):
        return None
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    return content if isinstance(content, str) and content.strip() else None


def error_message(payload: Any) -> str | None:
    """Best-effort human-readable error string from a LiteLLM error body
    (handles both the nested `{"error": {...}}` shape and flat top-level
    `message`/`detail`/`error` strings)."""
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("detail")
        if isinstance(message, str) and message.strip():
            return message.strip()
    for key in ("message", "detail", "error"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
