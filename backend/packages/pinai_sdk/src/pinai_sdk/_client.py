"""pinai_sdk async HTTP client + namespace facade.

Single module-level `client` singleton — sandbox scripts do:

    from pinai_sdk import client
    events = await client.events.search(q="market news", limit=20)

Public surface (one-liner per method, full signatures in the class
bodies below):

    client.events.search / append / curate         ← L1 timeline (read + write)
    client.user_strings.get_all / edit             ← L2 portrait
    client.feedback.list / log
    client.raw.list(toolkit, entity, ...)         ← canonical raw access
    client.raw.gmail.recent / client.raw.gcal.today  ← convenience

If you change the public surface, also update `SDK_CHEAT_SHEET` below
*and* `SANDBOX_PREAMBLE` in `agent_engine/agents/prompts/shared.py`
— the prompt block embeds the cheat sheet verbatim so agents see the
real shape on the first turn instead of inventing methods.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

# Typed raw sources, mirroring `web/routes/agent/raw.py:_RAW_TABLES`.
# Documentation, not a gate: toolkits NOT listed here are still readable —
# they live in the generic pai_raw_events store and `Raw.list` passes them
# through to the server (which routes typed vs generic). Listed toolkits
# get client-side entity validation as a fast-fail convenience.
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
    # Device (mobile sync) — snapshots + the ambient firehose. utterance /
    # transcript_window are the semantic-rollup sources (projector skips them
    # 1→1; evolve reads them via raw.list to collapse into episode events, §4.2).
    "device": ("apps", "contacts", "health", "utterance", "transcript_window"),
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


class Raw:
    """Generic raw-row access. `list(toolkit, entity, ...)` is the
    canonical entry — known sources are listed in `SUPPORTED_RAW_SOURCES`;
    any other connected toolkit reads through the same call (rows carry
    title/snippet + the full source item in `payload`). The server routes
    each read to its L0 domain table (apps connectors → pai_raw_apps, on-device
    data via toolkit="device" → pai_raw_device); the SDK surface is unchanged
    by that split. The `gmail` / `gcal` properties exist as convenience
    wrappers; everything else goes through `list()`.

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
        """Read recent rows from a raw source (the server routes by toolkit
        to its L0 domain table — apps connectors or device).

        Time window: pass `hours=N` for the last N hours, OR `since=` /
        `until=` for an absolute range. `hours` is translated to
        `since=now - N hours` client-side because the backend route
        accepts only `since` / `until` (ISO datetimes). Either parameter
        works; don't pass both.

        Returns rows ordered by `occurred_at DESC`, capped at `limit`.
        Use `offset` for deterministic paging.
        """
        # Known toolkits get early entity validation (clearer error than
        # the server's). Unknown toolkits pass through — the server routes
        # them to pai_raw_apps and is the enforcer either way.
        if toolkit in SUPPORTED_RAW_SOURCES and entity not in SUPPORTED_RAW_SOURCES[toolkit]:
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


class Settings(_Endpoint):
    """User settings the agent may change from chat. Language is the only
    one wired today — and it MUST flow through here (not a preference row)
    so it takes effect deterministically on the next generation."""

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/settings")

    async def set_generation_language(self, language: str) -> dict[str, Any]:
        """Flip generation_language and re-stamp the auto-generate schedule
        payload. `language` is a SupportedLanguage code (e.g. 'en',
        'zh-Hans')."""
        return await self._post(
            "/generation-language",
            {"generationLanguage": language},
        )


class Events(_Endpoint):
    """L1 event stream — the unified retrieval + append surface (supersedes
    memory/signals/raw reads). search is semantic when `q` is given, else a
    recency/type window; append records one event (idempotent on dedupe_key)."""

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/events")

    async def source(self, event_id: str) -> dict[str, Any]:
        """Verbatim L0 content behind an event (email body / calendar item /
        news article). Supersede-aware: a stale id resolves to the current
        revision server-side; events without raw archives return source=None."""
        return await self._get(f"/{event_id}/source")

    async def search(
        self,
        *,
        q: str | None = None,
        event_type: str | None = None,
        since: datetime | str | None = None,
        until: datetime | str | None = None,
        status: str = "active",
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        payload = await self._get(
            "/search",
            q=q,
            eventType=event_type,
            since=_iso(since) if since is not None else None,
            until=_iso(until) if until is not None else None,
            status=status,
            limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def append(
        self,
        *,
        event_type: str,
        title: str,
        # Must be in the api endpoint's _AGENT_WRITABLE_SOURCES allowlist
        # ({pinai_chat, agent_action, device}) or /api/agent/events/append 422s.
        # "agent_action" = the agent authored this event itself.
        source: str = "agent_action",
        body: str | None = None,
        structured: dict[str, Any] | None = None,
        occurred_at: datetime | str | None = None,
        end_at: datetime | str | None = None,
        dedupe_key: str | None = None,
    ) -> dict[str, Any]:
        return await self._post(
            "/append",
            {
                "source": source,
                "eventType": event_type,
                "title": title,
                "body": body,
                "structured": structured,
                "occurredAt": _iso(occurred_at) if occurred_at is not None else None,
                "endAt": _iso(end_at) if end_at is not None else None,
                "dedupeKey": dedupe_key,
            },
        )

    async def curate(self, *, id: str) -> dict[str, Any]:
        """Curation write — mark an event curated (evolve has processed it,
        stamping curated_at so it leaves the uncurated queue). No status/
        importance: noise is ordered down by the objective score, not flagged."""
        return await self._post("/curate", {"id": id})


class UserStrings(_Endpoint):
    """L2 profile portrait — read the five-slot portrait + memory_edit. All five
    slots are agent-maintained (the user only reads them):
    IDENTITY/SOUL/TOOLS (the agent's persona) + USER/GOALS (the user
    view). The AGENTS safety constant is not a slot."""

    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/user-strings")

    async def get_all(self) -> dict[str, Any]:
        payload = await self._get("/")
        return payload.get("slots", {}) if isinstance(payload, dict) else {}

    async def edit(
        self,
        *,
        slot: str,
        operations: list[dict[str, Any]],
        evidence_event_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"slot": slot, "operations": operations}
        if evidence_event_ids:
            body["evidenceEventIds"] = evidence_event_ids
        return await self._post("/edit", body)


class _Client:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self.events = Events(self)
        self.user_strings = UserStrings(self)
        self.feedback = Feedback(self)
        self.raw = Raw(self)
        self.composio = Composio(self)
        self.settings = Settings(self)

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            base = os.environ.get("PAI_API_URL", "http://api:8000")
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


# Stable text block embedded in agent_engine/agents/prompts/shared.py
# (SANDBOX_PREAMBLE) so every code-mode agent sees the full SDK shape on
# the first turn — kills the "first-call hallucination" pattern observed
# in evolve / dream / generator traces. If you change the public surface
# above, update this string AND the prompt-side embedding.
SDK_CHEAT_SHEET = """\
client.events                                        # L1 event stream — unified retrieval + append
  .search(*, q=None, event_type=None, since=None,    # q → semantic; no q → recency/type window
          until=None, status="active", limit=20) -> list  # status: active|pending (pending = evolve's queue)
  .append(*, event_type, title, source="agent_action",  # idempotent on dedupe_key; source must be in {pinai_chat, agent_action, device}
          body=None, structured=None, occurred_at=None,
          end_at=None, dedupe_key=None) -> dict
  .curate(*, id) -> dict                              # mark curated — evolve processed it (no status/importance)

client.user_strings                                  # L2 portrait — five-slot markdown profile
  .get_all() -> dict                                 # {IDENTITY, SOUL, TOOLS, USER, GOALS}
  .edit(*, slot, operations) -> dict                 # slot: any of IDENTITY/SOUL/TOOLS/USER/GOALS
                                                      # operations: [{op:"add"|"replace"|"remove", text, target}]
                                                      # over_budget → {ok:False, entries:[...]} consolidate+resend

client.feedback
  .list(*, kind=None, action=None, since=None, limit=50) -> list
  .log(*, kind, action=None, intent_card_id=None, intent_key=None,
       source="agent", basket=None, value=None, text=None,
       metadata=None, channel=None) -> dict

client.raw                                           # canonical entry: .list(toolkit, entity, ...)
  .list(toolkit, entity, *, hours=None, since=None, until=None,
        limit=50, offset=0, dedupe_key=None) -> list # pass hours OR since, not both
  .gmail.recent(*, hours=24, limit=20) -> list       # convenience
  .gcal.today(*, hours=48, limit=20) -> list         # convenience
  # other toolkits: use .list("slack","messages"), .list("github","issues"),
  #                 .list("gdrive","files"), .list("calendly","events"), ...
  # client.raw.slack / .github / etc DO NOT EXIST — use .list(...)

Typed (toolkit, entity) for raw.list:
  gmail/messages, gcal/events, gdrive/files, slack/messages,
  github/issues, calendly/events, stripe/invoices,
  youtube/subscriptions, linkedin/profile,
  device/{apps,contacts,health,utterance,transcript_window}
Any other connected toolkit reads the generic event store — call
.list("<toolkit>", "<entity>") with the recipe's entity_type (e.g.
.list("notion", "pages")); rows carry title/snippet plus the full
source item in `payload`.

client.composio                                      # live SaaS access via Composio Tool Router
  .connections() -> list                             # ACTIVE connected toolkits for the user
  .search(query, *, toolkit=None, limit=10) -> list  # discover tool slugs by use case
  .schema(slug) -> dict                              # full JSON schema for one slug
  .execute(slug, args=None, *,                       # run one tool
           connected_account_id=None) -> dict        # → {successful, data, error}
  .multi_execute(calls, *, parallelism=8) -> list    # run many in parallel
                                                      # calls: [{slug, args, connected_account_id?}]

client.settings                                      # user settings the agent may change
  .set_generation_language(language) -> dict         # 'en' | 'zh-Hans' | ...; deterministic, re-stamps schedule

All methods are async — `await` everything. Errors return
`{"error": "http_4xx", "detail": "..."}` instead of raising; check
`isinstance(res, dict) and "error" in res`."""
