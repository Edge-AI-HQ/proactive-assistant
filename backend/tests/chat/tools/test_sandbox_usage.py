from __future__ import annotations

import pytest
from agent_engine.tools.code_mode.lazy_sandbox import LazyThreadSandbox

pytestmark = pytest.mark.asyncio


class FakeBackend:
    async def als(self, path: str):
        return {"path": path, "entries": []}

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000):
        return {"path": file_path, "content": "hello", "offset": offset, "limit": limit}


async def test_sandbox_file_ops_report_daytona_usage(monkeypatch):
    reported: list[dict[str, object]] = []
    sandbox = LazyThreadSandbox("thread-123", run_jwt="jwt-sandbox")

    async def fake_ensure():
        return FakeBackend()

    monkeypatch.setattr(sandbox, "_ensure", fake_ensure)
    monkeypatch.setattr(
        "agent_engine.tools.code_mode.lazy_sandbox.report_compute_usage",
        lambda **kwargs: reported.append(kwargs),
    )

    assert await sandbox.als("/") == {"path": "/", "entries": []}
    assert await sandbox.aread("/tmp/a.txt", offset=1, limit=10) == {
        "path": "/tmp/a.txt",
        "content": "hello",
        "offset": 1,
        "limit": 10,
    }

    assert [item["source"] for item in reported] == ["daytona:ls", "daytona:read"]
    assert {item["provider"] for item in reported} == {"daytona"}
    assert {item["run_jwt"] for item in reported} == {"jwt-sandbox"}
