"""Composio side-effect policy — the shared safety contract.

Composio tool slugs follow `TOOLKIT_VERB_OBJECT` (e.g. `GMAIL_SEND_EMAIL`,
`GMAIL_GET_PROFILE`, `SLACK_SEND_MESSAGE`). Composio exposes no read/write
or side-effect flag in tool metadata, so side-effect-ness is derived from
the VERB segment of the slug.

`is_side_effecting` is the single source both processes consult: the api
process gates the sandbox code-mode execute routes with it; the engine
process drives HITL approval off the same judgement. Keeping it here (not
duplicated per process) is deliberate — if the two sides judged a slug
differently, one would gate while the other let it through, which is a
security hole. This module is pure (no IO, no deps) so it belongs in the
shared leaf rather than either service.

Policy is **fail-closed**: a VERB not in the read-only allowlist is treated
as side-effecting. New / unknown tools therefore default to the
"needs-approval" side — the correct posture for a security control.
"""

from __future__ import annotations

# VERBs that only read. Everything else (SEND / CREATE / UPDATE / DELETE /
# POST / ADD / REMOVE / MOVE / ARCHIVE / PAY / TRANSFER / INVITE / SHARE /
# MERGE / CLOSE / ...) is treated as a side-effect. Kept deliberately broad
# on the read side so genuinely read-only tools aren't falsely gated.
_SAFE_READ_VERBS = frozenset(
    {
        "GET",
        "LIST",
        "SEARCH",
        "FETCH",
        "READ",
        "RETRIEVE",
        "FIND",
        "CHECK",
        "DOWNLOAD",
        "EXPORT",
        "COUNT",
        "QUERY",
        "LOOKUP",
        "DESCRIBE",
        "VIEW",
    }
)

# Overrides for slugs the VERB heuristic gets wrong. Two kinds:
#   - read-only tools whose VERB looks mutating  → map to False
#   - high-risk tools to always block            → map to True (redundant
#     with fail-closed, but documents intent)
# Empty by design: populate from audit logs as real misjudgements surface,
# rather than guessing up front.
_SLUG_OVERRIDES: dict[str, bool] = {}


def is_side_effecting(slug: str) -> bool:
    """True if executing `slug` has external side effects (sends / creates /
    deletes / pays), False if it only reads.

    `slug` is a Composio tool slug shaped `TOOLKIT_VERB_OBJECT`; the VERB is
    the second underscore-delimited segment. Fail-closed: an unrecognized
    VERB (or a slug with no VERB segment) is treated as side-effecting.
    """
    override = _SLUG_OVERRIDES.get(slug)
    if override is not None:
        return override
    parts = slug.split("_", 2)
    verb = parts[1] if len(parts) >= 2 else parts[0]
    return verb.upper() not in _SAFE_READ_VERBS
