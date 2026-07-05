"""L2 profile Repository — the resident markdown portrait (hermes MemoryStore).

Schema: 112_pai_user_strings.sql.

Five slots: IDENTITY/SOUL/TOOLS (the agent's persona) + USER/GOALS (the user
view) — all five are agent-maintained via memory_edit; the user only reads them
(the Mirror page), there is no user write path. AGENTS (engine safety constant)
is not a slot here. Each slot's content is a §-delimited entry block. `edit` applies add/replace/remove
ops (a batch is just several ops in one call) with:
  * optimistic locking (version) — a concurrent edit forces a re-read, no lost
    updates;
  * a hard char_budget — an over-budget result FAILS and hands back every entry
    so the agent consolidates (hermes anti-truncation: never silently drop);
  * a threat scan — reserved markers are rejected at this trusted boundary
    before content can reach a prompt.
Success returns only the new version, NOT the entries (anti-thrash — the agent
shouldn't re-read and re-edit in a loop).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pinai_db.base import UserScopedRepository

# All five slots are agent-maintained (memory_edit), trusted in the portrait;
# the user only reads them (Mirror page), there is no user write path. The
# immutable AGENTS safety constant (agent_engine prompts/portrait.py) outranks
# them and is NOT a DB slot — neither user nor agent can edit it. Order mirrors
# the portrait injection order (IDENTITY → SOUL → USER → TOOLS → GOALS) so
# get_all() hands the portrait builder a stable, cache-friendly sequence.
_SLOTS = ("IDENTITY", "SOUL", "USER", "TOOLS", "GOALS")
_SEP = "§"

# Per-slot char budgets. IDENTITY/SOUL/TOOLS (agent persona) run smaller than
# USER (the user view); defaults match the migration's 4000 ceiling.
_SLOT_BUDGETS = {
    "IDENTITY": 2000,
    "SOUL": 2000,
    "TOOLS": 2000,
    "USER": 4000,
    "GOALS": 2000,
}

# Reserved markers content must never contain. Slots are no longer
# <untrusted-text>-wrapped, so the <portrait> envelope + the immutable AGENTS
# <agent_safety> block are the only injection boundary now. Block stored text
# from forging the safety block, breaking out of the portrait envelope, or
# injecting a NUL — defanged at this trusted write boundary.
_THREAT_MARKERS = (
    "<agent_safety>",
    "</agent_safety>",
    "<portrait>",
    "</portrait>",
    "\x00",
)


@dataclass(slots=True)
class EditOp:
    op: str  # 'add' | 'replace' | 'remove'
    text: str = ""  # new text (add / replace)
    target: str = ""  # substring identifying the entry (replace / remove)


@dataclass(slots=True)
class EditResult:
    ok: bool
    slot: str
    version: int
    reason: str | None = None  # over_budget | version_conflict | threat | bad_op
    entries: list[str] = field(default_factory=list)  # populated ONLY on over_budget


def _split(content: str) -> list[str]:
    return [e.strip() for e in content.split(_SEP) if e.strip()]


def _join(entries: list[str]) -> str:
    return f"\n{_SEP}\n".join(entries)


def _threat_scan(text: str) -> str | None:
    for marker in _THREAT_MARKERS:
        if marker in text:
            return f"reserved marker {marker!r}"
    return None


class UserStringsRepository(UserScopedRepository):
    async def get_slot(self, slot: str) -> tuple[str, int]:
        """(content, version). Missing row → ('', 1) so callers treat an empty
        slot uniformly without a separate existence check."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT content, version FROM pai_user_strings WHERE user_id=%s AND slot=%s",
                (self._user_id, slot),
            )
            row = await cur.fetchone()
        return (row["content"], row["version"]) if row else ("", 1)

    async def get_all(self) -> dict[str, str]:
        """All five slots' content (absent slots → '')."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT slot, content FROM pai_user_strings WHERE user_id=%s",
                (self._user_id,),
            )
            rows = await cur.fetchall()
        present = {r["slot"]: r["content"] for r in rows}
        return {s: present.get(s, "") for s in _SLOTS}

    async def edit(
        self,
        slot: str,
        *,
        operations: list[EditOp],
        expected_version: int | None = None,
    ) -> EditResult:
        """Apply ops to a slot's entry block. add/replace/remove; pass several
        ops for a batch (validated against the budget only at the end, so a
        delete-then-add consolidation that briefly dips over budget is fine)."""
        if slot not in _SLOTS:
            return EditResult(ok=False, slot=slot, version=0, reason="bad_op")

        content, version = await self.get_slot(slot)
        if expected_version is not None and expected_version != version:
            return EditResult(ok=False, slot=slot, version=version, reason="version_conflict")

        entries = _split(content)
        for op in operations:
            if op.op in ("add", "replace"):
                scan = _threat_scan(op.text)
                if scan is not None:
                    return EditResult(
                        ok=False, slot=slot, version=version, reason=f"threat: {scan}"
                    )
            if op.op == "add":
                entries.append(op.text.strip())
            elif op.op == "replace":
                entries = [op.text.strip() if op.target and op.target in e else e for e in entries]
            elif op.op == "remove":
                entries = [e for e in entries if not (op.target and op.target in e)]
            else:
                return EditResult(ok=False, slot=slot, version=version, reason=f"bad_op: {op.op}")

        new_content = _join(entries)
        budget = _SLOT_BUDGETS.get(slot, 4000)
        if len(new_content) > budget:
            # hermes anti-truncation: never silently drop. Fail and hand back
            # every entry so the agent consolidates and retries as one batch.
            return EditResult(
                ok=False, slot=slot, version=version, reason="over_budget", entries=entries
            )

        # Optimistic write: only commit if the row is still at the version we
        # read (a concurrent edit bumps it → WHERE fails → re-read).
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_user_strings (user_id, slot, content, char_budget, updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (user_id, slot) DO UPDATE SET
                  content = EXCLUDED.content,
                  version = pai_user_strings.version + 1,
                  updated_at = NOW()
                WHERE pai_user_strings.version = %s
                RETURNING version
                """,
                (self._user_id, slot, new_content, budget, version),
            )
            row = await cur.fetchone()

        if row is None:
            # ON CONFLICT WHERE version mismatch — a concurrent edit landed.
            _, current = await self.get_slot(slot)
            return EditResult(ok=False, slot=slot, version=current, reason="version_conflict")
        # Anti-thrash: success returns just the new version, not the entries.
        return EditResult(ok=True, slot=slot, version=row["version"])
