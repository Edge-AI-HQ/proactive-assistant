from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("TAVILY_API_KEY", "test")

from agent_engine.tools.code_mode import local_sandbox
from agent_engine.transport.routes import chat


def test_local_chat_root_dir_sanitizes_thread_id():
    root = local_sandbox.local_chat_root_dir("../main chat/用户")
    assert root == Path("/state/chat/main-chat")


def test_local_chat_root_dir_allows_root_override(monkeypatch):
    monkeypatch.setenv("PINAI_LOCAL_SANDBOX_ROOT", "/tmp/agent-engine")

    root = local_sandbox.local_chat_root_dir("main-1")

    assert root == Path("/tmp/agent-engine/main-1")


def test_chat_route_uses_local_backend_when_enabled(monkeypatch):
    sentinel = object()
    created: dict[str, object] = {}

    monkeypatch.setattr(chat, "use_local_sandbox", lambda: True)
    monkeypatch.setattr(chat, "local_chat_root_dir", lambda thread_id: Path(f"/tmp/{thread_id}"))

    def fake_create(*, run_jwt: str, root_dir: Path):
        created["run_jwt"] = run_jwt
        created["root_dir"] = root_dir
        return sentinel

    def fail_lazy(*_args, **_kwargs):
        raise AssertionError("LazyThreadSandbox must not be built in local sandbox mode")

    monkeypatch.setattr(chat, "create_local_sandbox_backend", fake_create)
    monkeypatch.setattr(chat, "LazyThreadSandbox", fail_lazy)

    backend = chat._get_thread_backend("thread-1", raw_jwt="jwt-1")

    assert backend is sentinel
    assert created == {"run_jwt": "jwt-1", "root_dir": Path("/tmp/thread-1")}
