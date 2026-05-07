"""pinai_sdk async HTTP client + namespace facade.

Single module-level `client` singleton — sandbox scripts do:
    from pinai_sdk import client
    rows = await client.memory.list(min_quality=0.7, limit=30)
"""

from __future__ import annotations

import os
from typing import Any

import httpx


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

    async def list(self, *, min_quality: float = 0.7, subject: str | None = None,
                   limit: int = 30) -> list[dict[str, Any]]:
        payload = await self._get("/list", minQuality=min_quality, subject=subject, limit=limit)
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def get(self, id: str) -> dict[str, Any] | None:
        return await self._get(f"/get/{id}")

    async def add(self, *, text: str, source: str = "agent",
                  subject: str | None = None, quality: float = 0.6,
                  source_run_id: str | None = None) -> dict[str, Any]:
        return await self._post("/add", {
            "text": text, "source": source, "subject": subject,
            "quality": quality, "sourceRunId": source_run_id,
        })


class Signals(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/signals")

    async def recent(self, *, status: str = "open", kind: str | None = None,
                     hours: int = 24, limit: int = 30) -> list[dict[str, Any]]:
        payload = await self._get(
            "/recent", status=status, kind=kind, hours=hours, limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def consume(self, *, id: str, run_id: str) -> None:
        await self._post("/consume", {"id": id, "runId": run_id})

    async def ingest(self, **fields: Any) -> dict[str, Any]:
        return await self._post("/ingest", fields)


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
        return await self._post("/upsert", {
            "displayName": display_name,
            "locale": locale,
            "timezone": timezone,
            "summary": summary,
            "facts": facts,
            "preferences": preferences,
            "constraints": constraints,
        })

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
        return await self._post("/goals/upsert", {
            "id": id,
            "key": key,
            "title": title,
            "priority": priority,
            "status": status,
            "summary": summary,
        })


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

    async def list(self, *, kind: str | None = None, action: str | None = None,
                   limit: int = 50) -> list[dict[str, Any]]:
        """Recent feedback events — used by generator to learn what the
        user dismissed / confirmed and shape the next batch."""
        payload = await self._get("/list", kind=kind, action=action, limit=limit)
        return payload.get("items", []) if isinstance(payload, dict) else []


class World(_Endpoint):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "/api/agent/world")

    async def recent(self, *, status: str = "open", provider: str | None = None,
                     hours: int | None = None, min_salience: float | None = None,
                     limit: int = 30) -> list[dict[str, Any]]:
        payload = await self._get(
            "/recent", status=status, provider=provider,
            hours=hours, minSalience=min_salience, limit=limit,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []

    async def score(self, *, id: str, salience: float,
                    scored_reason: str | None = None,
                    status: str = "open") -> None:
        await self._post("/score", {
            "id": id, "salience": salience,
            "scoredReason": scored_reason, "status": status,
        })

    async def consume(self, *, id: str, run_id: str) -> None:
        await self._post("/consume", {"id": id, "runId": run_id})

    async def reference(self, *, id: str, run_id: str) -> None:
        await self._post("/reference", {"id": id, "runId": run_id})


class _RawNamespace:
    """raw.gmail.recent / raw.gcal.today / raw.<toolkit>.<entity>"""

    def __init__(self, parent: _Client, toolkit: str) -> None:
        self._parent = parent
        self._toolkit = toolkit

    async def _list(self, entity: str, **params: Any) -> list[dict[str, Any]]:
        payload = await self._parent._get(
            f"/api/agent/raw/{self._toolkit}/{entity}", **params,
        )
        return payload.get("items", []) if isinstance(payload, dict) else []


class Raw:
    def __init__(self, parent: _Client) -> None:
        self._parent = parent

    @property
    def gmail(self) -> _GmailRaw:
        return _GmailRaw(self._parent)

    @property
    def gcal(self) -> _GcalRaw:
        return _GcalRaw(self._parent)

    def __getattr__(self, name: str) -> _RawNamespace:
        # Fallback for less-common toolkits: client.raw.spotify.recent_tracks(...)
        # via dynamic lookup. Returns a thin namespace that exposes <entity>(**params).
        return _RawNamespace(self._parent, name)


class _GmailRaw(_RawNamespace):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "gmail")

    async def recent(self, *, hours: int = 24, limit: int = 20) -> list[dict[str, Any]]:
        return await self._list("messages", hours=hours, limit=limit)


class _GcalRaw(_RawNamespace):
    def __init__(self, parent: _Client) -> None:
        super().__init__(parent, "gcal")

    async def today(self, *, hours: int = 48, limit: int = 20) -> list[dict[str, Any]]:
        return await self._list("events", hours=hours, limit=limit)


class _Client:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self.memory = Memory(self)
        self.signals = Signals(self)
        self.profile = Profile(self)
        self.cards = Cards(self)
        self.feedback = Feedback(self)
        self.world = World(self)
        self.raw = Raw(self)

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            base = os.environ.get("PAI_API_URL", "http://pinai-web:8000")
            self._client = httpx.AsyncClient(
                base_url=base,
                timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0),
                headers={"User-Agent": "pinai-sdk/0.1"},
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
