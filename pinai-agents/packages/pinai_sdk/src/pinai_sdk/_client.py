"""pinai_sdk async HTTP client + namespace facade.

Single module-level `client` singleton — sandbox scripts do:

    from pinai_sdk import client
    rows = await client.memory.list(min_quality=0.7, limit=30)

Public surface (one-liner per method, full signatures in the class
bodies below):

    client.memory.list / search / get / add / archive / supersede
    client.signals.recent / get / consume / add (alias: ingest)
    client.profile.get / upsert / merge_preference / upsert_goal
    client.cards.recent
    client.feedback.list / log
    client.world.recent / score / consume / reference
    client.raw.list(toolkit, entity, ...)         ← canonical raw access
    client.raw.gmail.recent / client.raw.gcal.today  ← convenience

If you change the public surface, also update `SDK_CHEAT_SHEET` below
*and* `SANDBOX_PREAMBLE` in `pinai_agents/chat/agents/prompts/shared.py`
— the prompt block embeds the cheat sheet verbatim so agents see the
real shape on the first turn instead of inventing methods.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

# Toolkit + entity allowlist, mirroring `web/routes/agent/raw.py:_RAW_TABLES`.
# Stays SDK-side as documentation: agents reading the SDK see exactly what
# raw sources exist instead of probing. Server still enforces; this is
# advisory.
SUPPORTED_RAW_SOURCES: dict[str, tuple[str, ...]] = {
    # Composio toolkits (Discord is connect_only — no raw table)
    "gmail": ("messages",),
    "gcal": ("events",),
    "gdrive": ("files",),
    "slack": ("messages",),
    "github": ("issues",),
    "calendly": ("events",),
    "stripe": ("invoices",),
    "youtube": ("subscriptions",),
    "linkedin": ("profile",),
    # Device (mobile sync)
    "device": ("apps", "contacts", "health"),
}


def _iso(dt: datetime | str) -> str:
    """Accept either a datetime or an already-ISO string. Server expects
    ISO; if caller passes a naive datetime we treat it as UTC (matches
    the convention used elsewhere in this codebase)."""
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.isoformat()


class _Endpoint:
    def __init__(self, parent: _Client, path_prefix: str) -> None:
        self._parent = parent
        self._prefix = path_prefix

    async def _get(self, path: str, **params: Any) -> Any:
        return await self._parent._get(f"{self._prefix}{path}", **params)

    async def _post(self, path: str, body: dict[str, Any]) -> Any:
        return await self._parent._post(f"{self._prefix}{path}", body)


class Memory(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/memory")

    async def list(
        self,
        *,
        min_quality: float = 0.7,
        subject: str | None = None,
        subject_prefix: str | None = None,
        since: datetime | str | None = None,
        limit: int = 30,
        offset: int = 0,
        order_by: str = "created_at_desc",
    ) -> list[dict[str, Any]]:
        payload = await self._get(
            "/list",
            minQuality=min_quality,
            subject=subject,
            subjectPrefix=subject_prefix,
            since=_iso(since) if since is not None else None,
            limit=limit,
            offset=offset,
            orderBy=order_by,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def search(
        self,
        *,
        q: str,
        min_quality: float | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Semantic search via pgvector. Falls back via 503 if the
        embedding service is down — caller can switch to .list with
        `subject_prefix` for keyword filtering."""
        payload = await self._get(
            "/search",
            q=q,
            minQuality=min_quality,
            limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def get(self, id: str) -> dict[str, Any] | None:
        return await self._get(f"/get/{id}")

    async def add(
        self,
        *,
        text: str,
        source: str = "agent",
        subject: str | None = None,
        quality: float = 0.6,
        confidence: float = 0.5,
        source_run_id: str | None = None,
        tags: list[str] | None = None,
        id: str | None = None,
    ) -> dict[str, Any]:
        return await self._post(
            "/add",
            {
                "id": id,
                "text": text,
                "source": source,
                "subject": subject,
                "quality": quality,
                "confidence": confidence,
                "sourceRunId": source_run_id,
                "tags": tags or [],
            },
        )

    async def archive(self, id: str) -> dict[str, Any] | None:
        """Mark a memory archived. Returns the archived row, or None if
        the id was already archived / missing."""
        return await self._post(f"/archive/{id}", {})

    async def supersede(
        self,
        *,
        old_id: str,
        new_id: str,
    ) -> dict[str, Any] | None:
        """Atomically replace old_id with new_id (used by dream/crystallize
        when restating a fact more accurately). Prefer one supersede over
        two archives + an add."""
        return await self._post(
            "/supersede",
            {"oldId": old_id, "newId": new_id},
        )


class Signals(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/signals")

    async def kinds(
        self,
        *,
        status: str = "all",
        hours: int | None = None,
    ) -> list[dict[str, Any]]:
        """List distinct signal `kind`s for the current user, with count +
        latest preview. Use to discover what data sources exist before
        drilling with `.recent(kind=...)`. status ∈ {open, consumed,
        archived, all}; default 'all' so already-consumed kinds still show
        up. Returns items shaped {kind, count, latestAt, latestTitle,
        latestSummaryPreview}, ordered by latestAt DESC."""
        payload = await self._get("/kinds", status=status, hours=hours)
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def recent(
        self,
        *,
        status: str = "open",
        kind: str | None = None,
        hours: int | None = 24,
        min_salience: float | None = None,
        limit: int = 30,
        include_payload: bool = False,
    ) -> list[dict[str, Any]]:
        """status ∈ {open, consumed, archived, all}. hours filters by
        occurred_at window (server-side translation to since)."""
        payload = await self._get(
            "/recent",
            status=status,
            kind=kind,
            hours=hours,
            minSalience=min_salience,
            limit=limit,
            includePayload=include_payload,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def get(self, id: str) -> dict[str, Any] | None:
        """Full payload for one signal — drill-down from .recent summary."""
        return await self._get(f"/get/{id}")

    async def consume(self, *, id: str, run_id: str) -> None:
        await self._post("/consume", {"id": id, "runId": run_id})

    async def add(
        self,
        *,
        kind: str,
        title: str,
        summary: str = "",
        salience: float = 0.0,
        confidence: float = 0.0,
        dedupe_key: str | None = None,
        subject: str | None = None,
        source: str = "agent",
        payload: dict[str, Any] | None = None,
        occurred_at: datetime | str | None = None,
        id: str | None = None,
    ) -> dict[str, Any]:
        """Create a new personal signal (ingest into the open queue).
        Use connector-natural keys for dedupe_key (gmail.<thread_id>,
        gcal.<event_id>) to avoid duplicates across evolve runs."""
        body: dict[str, Any] = {
            "kind": kind,
            "title": title,
            "summary": summary,
            "salience": salience,
            "confidence": confidence,
            "source": source,
        }
        if dedupe_key is not None:
            body["dedupeKey"] = dedupe_key
        if subject is not None:
            body["subject"] = subject
        if payload is not None:
            body["payload"] = payload
        if occurred_at is not None:
            body["occurredAt"] = _iso(occurred_at)
        if id is not None:
            body["id"] = id
        return await self._post("/ingest", body)

    async def ingest(self, **fields: Any) -> dict[str, Any]:
        """Backward-compatible alias for `add`. Prefer `add` — its
        signature is self-documenting."""
        return await self._post("/ingest", fields)


class Timeline(_Endpoint):
    """Unified time-axis event store dedicated to the proactive agent.
    Runs alongside client.signals.* / client.raw.* (unchanged) — it does
    not replace them.

    Mental model:
        ┌────────── past ──────────┐  ┌── future ──┐
        ─────────────────●──────────────────────────→
                       now (UTC)

    Each row is one event with `occurred_at` on the axis (past OR future).
    Interval events (meetings, audio sessions) have `end_at`; point
    events leave it NULL.

    By default `.query()` strips out: predicted events, pending/filtered
    rows, and importance < 0.3. Opt-in via parameters.
    """

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/timeline")

    async def query(
        self,
        *,
        window_start: datetime | str,
        window_end: datetime | str,
        sources: list[str] | None = None,
        event_types: list[str] | None = None,
        min_importance: float = 0.3,
        include_predicted: bool = False,
        include_pending: bool = True,
        include_filtered: bool = False,
        include_superseded: bool = False,
        include_body: bool = False,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Window scan, returned chronological ASC.

        `sources`: e.g. ['gmail', 'gcal', 'ambient.utterance']
        `event_types`: e.g. ['meeting', 'communication']
        """
        payload = await self._get(
            "/query",
            windowStart=_iso(window_start),
            windowEnd=_iso(window_end),
            sources=",".join(sources) if sources else None,
            eventTypes=",".join(event_types) if event_types else None,
            minImportance=min_importance,
            includePredicted=include_predicted,
            includePending=include_pending,
            includeFiltered=include_filtered,
            includeSuperseded=include_superseded,
            includeBody=include_body,
            limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def past(
        self,
        *,
        hours: int = 168,
        **filters: Any,
    ) -> list[dict[str, Any]]:
        """Convenience: events in `[now - hours, now]`. Default = past
        7 days."""
        now = datetime.now(UTC)
        return await self.query(
            window_start=now - timedelta(hours=hours),
            window_end=now,
            **filters,
        )

    async def future(
        self,
        *,
        hours: int = 168,
        include_predicted: bool = True,
        **filters: Any,
    ) -> list[dict[str, Any]]:
        """Convenience: events in `[now, now + hours]`. Default = next
        7 days; includes LLM-predicted future events by default
        (`include_predicted=True`) since that's the main reason to ask
        for the future view."""
        now = datetime.now(UTC)
        filters.setdefault("include_predicted", include_predicted)
        return await self.query(
            window_start=now,
            window_end=now + timedelta(hours=hours),
            **filters,
        )

    async def ingested_window(
        self,
        *,
        after: datetime | str,
        before: datetime | str,
        limit: int = 500,
        include_body: bool = True,
    ) -> list[dict[str, Any]]:
        """Events that ARRIVED (ingested_at) in `(after, before]`, in
        ingestion order. This is the evolve agent's input — it walks the
        stream by ingestion time (not occurred_at) so a backdated email
        fetched today is still distilled today. Predicted / filtered /
        superseded rows are excluded; pending rows are included."""
        payload = await self._get(
            "/ingested_window",
            after=_iso(after),
            before=_iso(before),
            limit=limit,
            includeBody=include_body,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def in_progress(
        self,
        *,
        at: datetime | str | None = None,
        sources: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Interval events covering `at` (defaults to now). Returns
        "meetings/calls/sessions currently in session"."""
        payload = await self._get(
            "/in_progress",
            at=_iso(at) if at is not None else None,
            sources=",".join(sources) if sources else None,
            limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def get(self, event_id: str) -> dict[str, Any] | None:
        """Full event with body / metadata / history / source_ref —
        drill-down from `query` summary."""
        return await self._get(f"/get/{event_id}")

    async def history(self, event_id: str) -> list[dict[str, Any]]:
        """Walk the supersede chain. Returns root → current chronological.
        Used for "this event was rescheduled — what did the user originally
        plan" queries."""
        payload = await self._get(f"/history/{event_id}")
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def ingest(
        self,
        *,
        occurred_at: datetime | str,
        source: str,
        event_type: str,
        title: str,
        source_ref: dict[str, Any],
        end_at: datetime | str | None = None,
        body: str | None = None,
        participants: list[dict[str, Any]] | None = None,
        location: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        importance: float = 0.5,
        confidence: float = 1.0,
        is_predicted: bool = False,
        curation_status: str = "curated",
        filter_reason: str | None = None,
        dedupe_key: str | None = None,
        id: str | None = None,
    ) -> dict[str, Any]:
        """Insert or UPSERT one timeline event. Used by the evolve agent
        (digital curation) and the ambient ingest path.

        `dedupe_key` shape recommendations:
          gmail:<message_id> | gcal:<event_id> |
          ambient:utterance:<device_id>:<client_event_id> |
          predicted.gcal:<seed_event_id>:<predicted_at_iso>

        UPSERT semantics: re-running with the same dedupe_key updates
        content but won't bump a curated row back to pending.
        """
        body_dict: dict[str, Any] = {
            "occurredAt": _iso(occurred_at),
            "source": source,
            "eventType": event_type,
            "title": title,
            "sourceRef": source_ref,
            "importance": importance,
            "confidence": confidence,
            "isPredicted": is_predicted,
            "curationStatus": curation_status,
        }
        if end_at is not None:
            body_dict["endAt"] = _iso(end_at)
        if body is not None:
            body_dict["body"] = body
        if participants is not None:
            body_dict["participants"] = participants
        if location is not None:
            body_dict["location"] = location
        if metadata is not None:
            body_dict["metadata"] = metadata
        if filter_reason is not None:
            body_dict["filterReason"] = filter_reason
        if dedupe_key is not None:
            body_dict["dedupeKey"] = dedupe_key
        if id is not None:
            body_dict["id"] = id
        return await self._post("/ingest", body_dict)

    async def supersede(
        self,
        *,
        old_id: str,
        new_event: dict[str, Any],
        changed_fields: dict[str, Any] | None = None,
        by: str = "rule",
    ) -> dict[str, Any]:
        """Reschedule chain: replace `old_id` with a new event.

        `new_event` must have the same shape as ingest() takes (camelCase
        keys). Both rows survive — default queries return only the latest;
        `.history(id)` walks the chain.
        """
        body: dict[str, Any] = {
            "oldId": old_id,
            "newEvent": new_event,
            "by": by,
        }
        if changed_fields is not None:
            body["changedFields"] = changed_fields
        return await self._post("/supersede", body)

    async def reference(
        self,
        *,
        ids: list[str],
        run_id: str | None = None,
    ) -> None:
        """Mark events as referenced by this run. Bumps reference_count
        and appends run_id to referenced_by_runs. Generator / dream
        call this after consuming events to make evidence consumption
        auditable."""
        body: dict[str, Any] = {"ids": ids}
        if run_id is not None:
            body["runId"] = run_id
        await self._post("/reference", body)


class Profile(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/profile")

    async def get(self) -> dict[str, Any]:
        """Returns `{"profile": {...} | None, "goals": [...]}` — both
        the persona row and active goals in one call."""
        return await self._get("/get")

    async def upsert(
        self,
        *,
        display_name: str | None = None,
        locale: str | None = None,
        timezone: str | None = None,
        summary: str | None = None,
        facts: dict[str, Any] | None = None,
        preferences: dict[str, Any] | None = None,
        constraints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Partial upsert — pass only fields you want to change. Server
        COALESCEs missing fields against the existing row, so a single-
        field call doesn't clobber the rest. JSONB buckets (facts /
        preferences / constraints) are *replaced wholesale* — read-merge-
        write client-side if you want to preserve sibling keys."""
        return await self._post(
            "/upsert",
            {
                "displayName": display_name,
                "locale": locale,
                "timezone": timezone,
                "summary": summary,
                "facts": facts,
                "preferences": preferences,
                "constraints": constraints,
            },
        )

    async def upsert_goal(
        self,
        *,
        key: str,
        title: str,
        id: str | None = None,
        priority: str = "medium",
        status: str = "active",
        summary: str | None = None,
    ) -> dict[str, Any]:
        """Insert or update a long-term named goal. Conflict-on-`key`,
        so passing the same `key` twice updates in place. Use a stable
        slug (`'sub3-marathon'`, `'staff-promo-2026'`)."""
        return await self._post(
            "/goals/upsert",
            {
                "id": id,
                "key": key,
                "title": title,
                "priority": priority,
                "status": status,
                "summary": summary,
            },
        )

    async def merge_preference(self, *, key: str, value: str) -> dict[str, Any]:
        """Merge one durable preference into pai_profile.preferences.
        Safer than `upsert(preferences=...)` because it preserves sibling
        keys server-side."""
        return await self._post(
            "/preferences/merge",
            {
                "key": key,
                "value": value,
            },
        )


class Cards(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/cards")

    async def recent(self, *, limit: int = 30) -> list[dict[str, Any]]:
        """Recent cards across pipeline runs — used by generator to avoid
        repeating cards already pushed in prior runs."""
        payload = await self._get("/recent", limit=limit)
        return payload.get("items", []) if isinstance(payload, dict) else []


class Feedback(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/feedback")

    async def list(
        self,
        *,
        kind: str | None = None,
        action: str | None = None,
        since: datetime | str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Recent feedback events — used by generator to learn what the
        user dismissed / confirmed and shape the next batch."""
        payload = await self._get(
            "/list",
            kind=kind,
            action=action,
            since=_iso(since) if since is not None else None,
            limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def log(
        self,
        *,
        kind: str,
        action: str | None = None,
        intent_card_id: str | None = None,
        intent_key: str | None = None,
        source: str = "agent",
        basket: str | None = None,
        value: Any | None = None,
        text: str | None = None,
        metadata: dict[str, Any] | None = None,
        channel: str | None = None,
    ) -> dict[str, Any]:
        """Log an agent-derived feedback event (crystallize / dream).
        `source='agent'` distinguishes from user-direct feedback."""
        return await self._post(
            "/log",
            {
                "kind": kind,
                "action": action,
                "intentCardId": intent_card_id,
                "intentKey": intent_key,
                "source": source,
                "basket": basket,
                "value": value,
                "text": text,
                "metadata": metadata or {},
                "channel": channel,
            },
        )


class World(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/world")

    async def recent(
        self,
        *,
        status: str = "open",
        provider: str | None = None,
        hours: int | None = None,
        min_salience: float | None = None,
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        payload = await self._get(
            "/recent",
            status=status,
            provider=provider,
            hours=hours,
            minSalience=min_salience,
            limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def search(
        self,
        *,
        q: str,
        limit: int = 10,
        status: str = "open",
    ) -> list[dict[str, Any]]:
        """Hybrid keyword + semantic search. Server runs tsvector full-text
        and pgvector cosine in parallel, fuses by RRF (k=60). Use when
        you need world-news context for a SPECIFIC topic — `recent()` is
        for the "what's salient lately" pull."""
        payload = await self._get("/search", q=q, limit=limit, status=status)
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def score(
        self,
        *,
        id: str,
        salience: float,
        scored_reason: str | None = None,
        status: str = "open",
    ) -> None:
        await self._post(
            "/score",
            {
                "id": id,
                "salience": salience,
                "scoredReason": scored_reason,
                "status": status,
            },
        )

    async def consume(self, *, id: str, run_id: str) -> None:
        await self._post("/consume", {"id": id, "runId": run_id})

    async def reference(self, *, id: str, run_id: str) -> None:
        await self._post("/reference", {"id": id, "runId": run_id})


class Raw:
    """Generic raw-row access. `list(toolkit, entity, ...)` is the
    canonical entry — works for every (toolkit, entity) in
    `SUPPORTED_RAW_SOURCES`. The `gmail` / `gcal` properties exist as
    convenience wrappers; everything else goes through `list()`.

    Important: there is NO `__getattr__` magic here. `client.raw.slack`
    does NOT exist — use `client.raw.list("slack", "messages", ...)`.
    Same for github / notion / drive / etc. The explicit shape is
    deliberate: dynamic attribute resolution leads agents to invent
    method names like `raw.slack.messages(...)` that fail at runtime.
    """

    def __init__(self, parent: _Client) -> None:
        self._parent = parent

    async def list(
        self,
        toolkit: str,
        entity: str,
        *,
        hours: int | None = None,
        since: datetime | str | None = None,
        until: datetime | str | None = None,
        limit: int = 50,
        offset: int = 0,
        dedupe_key: str | None = None,
    ) -> list[dict[str, Any]]:
        """Read recent rows from a typed raw source.

        Time window: pass `hours=N` for the last N hours, OR `since=` /
        `until=` for an absolute range. `hours` is translated to
        `since=now - N hours` client-side because the backend route
        accepts only `since` / `until` (ISO datetimes). Either parameter
        works; don't pass both.

        Returns rows ordered by `occurred_at DESC`, capped at `limit`.
        Use `offset` for deterministic paging.
        """
        # Validate (toolkit, entity) early — saves a round-trip + gives
        # a clearer error than the server's 404. Server still enforces.
        if toolkit not in SUPPORTED_RAW_SOURCES:
            msg = f"unknown raw toolkit: {toolkit!r}. Supported: {sorted(SUPPORTED_RAW_SOURCES)}"
            raise ValueError(msg)
        if entity not in SUPPORTED_RAW_SOURCES[toolkit]:
            msg = (
                f"unknown raw entity for {toolkit!r}: {entity!r}. "
                f"Supported: {SUPPORTED_RAW_SOURCES[toolkit]}"
            )
            raise ValueError(msg)

        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if since is not None:
            params["since"] = _iso(since)
        elif hours is not None:
            params["since"] = _iso(datetime.now(UTC) - timedelta(hours=hours))
        if until is not None:
            params["until"] = _iso(until)
        if dedupe_key is not None:
            params["dedupeKey"] = dedupe_key

        payload = await self._parent._get(
            f"/api/agent/raw/{toolkit}/{entity}",
            **params,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    @property
    def gmail(self) -> _GmailRaw:
        return _GmailRaw(self)

    @property
    def gcal(self) -> _GcalRaw:
        return _GcalRaw(self)


class _GmailRaw:
    def __init__(self, raw: Raw) -> None:
        self._raw = raw

    async def recent(
        self,
        *,
        hours: int = 24,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        return await self._raw.list(
            "gmail",
            "messages",
            hours=hours,
            limit=limit,
        )


class _GcalRaw:
    def __init__(self, raw: Raw) -> None:
        self._raw = raw

    async def today(
        self,
        *,
        hours: int = 48,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        return await self._raw.list(
            "gcal",
            "events",
            hours=hours,
            limit=limit,
        )


class Composio(_Endpoint):
    """Composio Tool Router access for SDK code-mode agents (generator /
    dream / evolve / crystallize). Backs onto the SAME endpoints the
    chat-process native @tools forward to, but exposes them as method
    calls suitable for use inside a Python sandbox script.

    Use cases:
      * Live SaaS reads (fresh inbox state, just-now calendar, …) when
        the offline-ingested raw cache isn't fresh enough.
      * Cross-toolkit aggregation in one Python script (Gmail + GCal +
        GitHub joined locally, distilled output piped back).
      * Side-effect actions (send email, create event) — no per-call
        gating yet; treat with the same care as `personal_exec`.
    """

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/composio")

    async def connections(self) -> list[dict[str, Any]]:
        """List the user's ACTIVE Composio connections."""
        payload = await self._get("/connections")
        if isinstance(payload, dict) and "items" in payload:
            return payload["items"]
        return []

    async def search(
        self,
        query: str,
        *,
        toolkit: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Search Composio's tool catalog by use-case query. Returns
        ranked tool slugs + descriptions; call .schema() for full args.
        """
        payload = await self._post(
            "/search",
            {
                "query": query,
                "toolkit": toolkit,
                "limit": limit,
            },
        )
        if isinstance(payload, dict) and "items" in payload:
            return payload["items"]
        return []

    async def schema(self, slug: str) -> dict[str, Any]:
        """Fetch full input/output JSON Schema for one tool slug."""
        return await self._get(f"/schema/{slug}")

    async def execute(
        self,
        slug: str,
        args: dict[str, Any] | None = None,
        *,
        connected_account_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute one Composio tool. `args` matches the tool's input
        schema (use .schema(slug) to confirm). Errors come back inside
        the response (`{successful: false, error: "..."}`)."""
        return await self._post(
            "/execute",
            {
                "slug": slug,
                "args": args or {},
                "connected_account_id": connected_account_id,
            },
        )

    async def multi_execute(
        self,
        calls: list[dict[str, Any]],
        *,
        parallelism: int = 8,
    ) -> list[dict[str, Any]]:
        """Run multiple Composio tools in parallel. Each call:
        {slug, args, connected_account_id?}. Returns one ExecuteResult
        per call in the same order."""
        payload = await self._post(
            "/multi_execute",
            {
                "calls": calls,
                "parallelism": parallelism,
            },
        )
        if isinstance(payload, dict) and "results" in payload:
            return payload["results"]
        return []


class Preferences(_Endpoint):
    """High-weight user preferences stated in plain words in main chat.
    Read by generation context collection so the planner can treat the
    most recent / highest-weight ones as near-hard constraints. Writes go
    through the chat agent's native tool, not usually the sandbox — but
    `add` / `supersede` are here for code-mode agents that distil a
    preference."""

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/preferences")

    async def list(
        self,
        *,
        status: str = "active",
        scope: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List preferences, newest first. status ∈ {active, superseded,
        archived}; default 'active' is what generation should read."""
        payload = await self._get("/list", status=status, scope=scope, limit=limit)
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def add(
        self,
        *,
        statement: str,
        scope: str,
        polarity: str,
        weight: float | None = None,
        confidence: float | None = None,
        durability: str = "persistent",
        expires_at: datetime | str | None = None,
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist a stated preference. `source` is stamped server-side
        from the run principal — you cannot set it here."""
        return await self._post(
            "/add",
            {
                "statement": statement,
                "scope": scope,
                "polarity": polarity,
                "weight": weight,
                "confidence": confidence,
                "durability": durability,
                "expiresAt": _iso(expires_at) if expires_at is not None else None,
                "evidence": evidence or {},
            },
        )

    async def supersede(
        self,
        *,
        old_id: str,
        new_id: str,
    ) -> dict[str, Any] | None:
        """Mark old_id superseded by new_id (new_id must already be active)."""
        return await self._post("/supersede", {"oldId": old_id, "newId": new_id})


class Settings(_Endpoint):
    """User settings the agent may change from chat. Language is the only
    one wired today — and it MUST flow through here (not a preference row)
    so it takes effect deterministically on the next generation."""

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/profile/settings")

    async def set_generation_language(self, language: str) -> dict[str, Any]:
        """Flip generation_language and re-stamp the auto-generate schedule
        payload. `language` is a SupportedLanguage code (e.g. 'en',
        'zh-Hans')."""
        return await self._post(
            "/generation-language",
            {"generationLanguage": language},
        )


class _Client:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self.memory = Memory(self)
        self.signals = Signals(self)
        self.timeline = Timeline(self)
        self.profile = Profile(self)
        self.cards = Cards(self)
        self.feedback = Feedback(self)
        self.world = World(self)
        self.raw = Raw(self)
        self.composio = Composio(self)
        self.preferences = Preferences(self)
        self.settings = Settings(self)

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            base = os.environ.get("PAI_API_URL", "http://pinai-web:8000")
            self._client = httpx.AsyncClient(
                base_url=base,
                timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0),
                headers={"User-Agent": "pinai-sdk/0.2"},
            )
        return self._client

    def _auth(self) -> dict[str, str]:
        # Phantom-token first (industry pattern: chat process mints, web
        # resolves; the sandbox NEVER sees the user's chat-driving JWT or
        # virtual_key). Falls back to PAI_RUN_JWT for legacy / test
        # callers that haven't migrated to phantom yet.
        token = os.environ.get("PAI_SANDBOX_TOKEN") or os.environ.get("PAI_RUN_JWT")
        if not token:
            msg = (
                "neither PAI_SANDBOX_TOKEN nor PAI_RUN_JWT set in env — "
                "sandbox launcher must inject one"
            )
            raise RuntimeError(msg)
        return {"Authorization": f"Bearer {token}"}

    async def _get(self, path: str, **params: Any) -> Any:
        cleaned = {k: v for k, v in params.items() if v is not None}
        resp = await self._ensure_client().get(path, params=cleaned, headers=self._auth())
        if resp.status_code >= 400:
            return {"error": f"http_{resp.status_code}", "detail": resp.text[:500]}
        return resp.json()

    async def _post(self, path: str, body: dict[str, Any]) -> Any:
        resp = await self._ensure_client().post(path, json=body, headers=self._auth())
        if resp.status_code >= 400:
            return {"error": f"http_{resp.status_code}", "detail": resp.text[:500]}
        return resp.json()


client = _Client()


# Stable text block embedded in pinai_agents/chat/agents/prompts/shared.py
# (SANDBOX_PREAMBLE) so every code-mode agent sees the full SDK shape on
# the first turn — kills the "first-call hallucination" pattern observed
# in evolve / dream / generator traces. If you change the public surface
# above, update this string AND the prompt-side embedding.
SDK_CHEAT_SHEET = """\
client.memory
  .list(*, min_quality=0.7, subject=None, subject_prefix=None,
        since=None, limit=30, offset=0, order_by="created_at_desc") -> list
  .search(*, q, min_quality=None, limit=10) -> list
  .get(id) -> dict | None
  .add(*, text, source="agent", subject=None, quality=0.6,
       confidence=0.5, source_run_id=None, tags=None, id=None) -> dict
  .archive(id) -> dict | None
  .supersede(*, old_id, new_id) -> dict | None

client.signals
  .kinds(*, status="all", hours=None) -> list       # discover what kinds exist
                                                     # → [{kind, count, latestAt, latestTitle, latestSummaryPreview}]
  .recent(*, status="open", kind=None, hours=24,
          min_salience=None, limit=30,
          include_payload=False) -> list            # status: open|consumed|archived|all
  .get(id) -> dict | None
  .consume(*, id, run_id) -> None
  .add(*, kind, title, summary="", salience=0.0, confidence=0.0,
       dedupe_key=None, subject=None, source="agent",
       payload=None, occurred_at=None, id=None) -> dict
  .ingest(**fields) -> dict                          # legacy; prefer .add

client.profile
  .get() -> {"profile": ... | None, "goals": [...]}
  .upsert(*, display_name=None, locale=None, timezone=None,
          summary=None, facts=None, preferences=None,
          constraints=None) -> dict                  # JSONB buckets replaced wholesale
  .merge_preference(*, key, value) -> dict           # safe one-key merge into profile.preferences
  .upsert_goal(*, key, title, id=None, priority="medium",
               status="active", summary=None) -> dict

client.cards
  .recent(*, limit=30) -> list

client.feedback
  .list(*, kind=None, action=None, since=None, limit=50) -> list
  .log(*, kind, action=None, intent_card_id=None, intent_key=None,
       source="agent", basket=None, value=None, text=None,
       metadata=None, channel=None) -> dict

client.world
  .recent(*, status="open", provider=None, hours=None,
          min_salience=None, limit=30) -> list
  .score(*, id, salience, scored_reason=None, status="open") -> None
  .consume(*, id, run_id) -> None
  .reference(*, id, run_id) -> None

client.raw                                           # canonical entry: .list(toolkit, entity, ...)
  .list(toolkit, entity, *, hours=None, since=None, until=None,
        limit=50, offset=0, dedupe_key=None) -> list # pass hours OR since, not both
  .gmail.recent(*, hours=24, limit=20) -> list       # convenience
  .gcal.today(*, hours=48, limit=20) -> list         # convenience
  # other toolkits: use .list("slack","messages"), .list("github","issues"),
  #                 .list("gdrive","files"), .list("calendly","events"), ...
  # client.raw.slack / .github / etc DO NOT EXIST — use .list(...)

Supported (toolkit, entity) for raw.list:
  gmail/messages, gcal/events, gdrive/files, slack/messages,
  github/issues, calendly/events, stripe/invoices,
  youtube/subscriptions, linkedin/profile,
  device/{apps,contacts,health}

client.composio                                      # live SaaS access via Composio Tool Router
  .connections() -> list                             # ACTIVE connected toolkits for the user
  .search(query, *, toolkit=None, limit=10) -> list  # discover tool slugs by use case
  .schema(slug) -> dict                              # full JSON schema for one slug
  .execute(slug, args=None, *,                       # run one tool
           connected_account_id=None) -> dict        # → {successful, data, error}
  .multi_execute(calls, *, parallelism=8) -> list    # run many in parallel
                                                      # calls: [{slug, args, connected_account_id?}]

client.preferences                                   # high-weight stated preferences (main-chat)
  .list(*, status="active", scope=None, limit=50) -> list  # newest first; read active for generation
  .add(*, statement, scope, polarity, weight=None,   # source stamped server-side, not here
       confidence=None, durability="persistent",
       expires_at=None, evidence=None) -> dict        # scope: topic|source|timing|format|global
                                                      # polarity: positive|negative
  .supersede(*, old_id, new_id) -> dict | None       # new_id must already be active

client.settings                                      # user settings the agent may change
  .set_generation_language(language) -> dict         # 'en' | 'zh-Hans' | ...; deterministic, re-stamps schedule

All methods are async — `await` everything. Errors return
`{"error": "http_4xx", "detail": "..."}` instead of raising; check
`isinstance(res, dict) and "error" in res`."""
