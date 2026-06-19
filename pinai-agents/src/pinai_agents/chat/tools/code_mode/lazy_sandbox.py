"""Lazy thread-sandbox proxy (P1 root-cause fix).

Pure conversation must never touch Daytona. The prod hang was: every turn
eagerly provisioned/resumed a Daytona sandbox *before* the LLM ran, so a
slow Daytona wedged even a "你好" that needs no sandbox at all.

deepagents only calls a backend method when the LLM actually invokes a
file/exec tool — filesystem middleware calls `als/aread/awrite/aedit` from
inside the ls/read_file/write_file/edit_file tools, the execute tool calls
`aexecute`, and `awrap_model_call`'s only backend touch is an `isinstance`
check (`supports_execution`) that never provisions. Summarization offloads
to the backend only past a token threshold. So we hand the agent a proxy
that provisions the REAL Daytona sandbox on the first such call and reuses
it thereafter. A short pure-text turn never calls `_ensure`, so it never
provisions — that is the fix (a long one can still provision once it crosses
the summarization threshold above; that path is correct and bounded by the
P0 provisioning timeout).

This is deepagents' officially-recommended production posture ("lazy
provisioning ... sandboxes are created when needed"), reached through the
framework's own `SandboxBackendProtocol` extension point —
`isinstance(LazyThreadSandbox, SandboxBackendProtocol)` is True, so the
execute tool is kept and the type check itself never provisions.

Async-only: the chat agent runs on deepagents' async path (`astream_events`
v2), which calls only the `a*` methods. Sync callers fall through to the
protocol's `NotImplementedError` rather than silently bypassing lazy
provisioning.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable

import daytona
from deepagents.backends.protocol import (
    EditResult,
    ExecuteResponse,
    FileDownloadResponse,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    SandboxBackendProtocol,
    WriteResult,
)
from langchain_daytona import DaytonaSandbox

from ..usage_report import report_compute_usage
from .sandbox import get_or_create_thread_sandbox


class LazyThreadSandbox(SandboxBackendProtocol):
    """`SandboxBackendProtocol` proxy that defers Daytona provisioning to the
    first real file/exec tool call. See the module docstring."""

    def __init__(self, thread_id: str, *, run_jwt: str | None = None) -> None:
        self._thread_id = thread_id
        self._run_jwt = run_jwt
        self._real: DaytonaSandbox | None = None
        self._raw: daytona.Sandbox | None = None
        # Coalesce concurrent first-touches (parallel tool calls in one turn)
        # so we provision exactly once.
        self._lock = asyncio.Lock()

    async def _ensure(self) -> DaytonaSandbox:
        """Provision (or fetch the cached) Daytona sandbox on first use.

        `_real` is a turn-scoped snapshot: a fresh proxy is built per turn,
        so it can't outlive a registry LRU/GC eviction beyond the current
        turn. The next turn's proxy re-fetches through
        `get_or_create_thread_sandbox`, which re-validates or recreates."""
        if self._real is None:
            async with self._lock:
                if self._real is None:
                    backend, raw = await get_or_create_thread_sandbox(
                        self._thread_id, run_jwt=self._run_jwt
                    )
                    self._real, self._raw = backend, raw
        return self._real

    @property
    def id(self) -> str:
        # Never provision just to read an id — tracing/logging touch this.
        return self._raw.id if self._raw is not None else f"lazy:{self._thread_id}"

    # ── async surface (the only path the async agent uses) ──

    async def _metered[T](self, source: str, fn: Callable[[], Awaitable[T]]) -> T:
        start = time.monotonic()
        try:
            return await fn()
        finally:
            report_compute_usage(
                provider="daytona",
                duration_seconds=time.monotonic() - start,
                source=source,
                metadata={"threadId": self._thread_id},
                run_jwt=self._run_jwt,
            )

    async def aexecute(
        self,
        command: str,
        *,
        timeout: int | None = None,  # noqa: ASYNC109  # forwarded to the real backend
    ) -> ExecuteResponse:
        async def _run() -> ExecuteResponse:
            return await (await self._ensure()).aexecute(command, timeout=timeout)

        return await self._metered("daytona:exec", _run)

    async def als(self, path: str) -> LsResult:
        async def _run() -> LsResult:
            return await (await self._ensure()).als(path)

        return await self._metered("daytona:ls", _run)

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        async def _run() -> ReadResult:
            return await (await self._ensure()).aread(file_path, offset, limit)

        return await self._metered("daytona:read", _run)

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        async def _run() -> WriteResult:
            return await (await self._ensure()).awrite(file_path, content)

        return await self._metered("daytona:write", _run)

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,  # noqa: FBT001, FBT002  # matches protocol signature
    ) -> EditResult:
        async def _run() -> EditResult:
            return await (await self._ensure()).aedit(
                file_path, old_string, new_string, replace_all
            )

        return await self._metered("daytona:edit", _run)

    async def agrep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult:
        async def _run() -> GrepResult:
            return await (await self._ensure()).agrep(pattern, path, glob)

        return await self._metered("daytona:grep", _run)

    async def aglob(self, pattern: str, path: str = "/") -> GlobResult:
        async def _run() -> GlobResult:
            return await (await self._ensure()).aglob(pattern, path)

        return await self._metered("daytona:glob", _run)

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        async def _run() -> list[FileUploadResponse]:
            return await (await self._ensure()).aupload_files(files)

        return await self._metered("daytona:upload", _run)

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        async def _run() -> list[FileDownloadResponse]:
            return await (await self._ensure()).adownload_files(paths)

        return await self._metered("daytona:download", _run)
