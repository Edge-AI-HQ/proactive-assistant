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
it thereafter. A pure-text turn never calls `_ensure`, so it never
provisions — that is the fix.

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
        """Provision (or fetch the cached) Daytona sandbox on first use."""
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

    async def aexecute(
        self,
        command: str,
        *,
        timeout: int | None = None,  # noqa: ASYNC109  # forwarded to the real backend
    ) -> ExecuteResponse:
        return await (await self._ensure()).aexecute(command, timeout=timeout)

    async def als(self, path: str) -> LsResult:
        return await (await self._ensure()).als(path)

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        return await (await self._ensure()).aread(file_path, offset, limit)

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        return await (await self._ensure()).awrite(file_path, content)

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,  # noqa: FBT001, FBT002  # matches protocol signature
    ) -> EditResult:
        return await (await self._ensure()).aedit(file_path, old_string, new_string, replace_all)

    async def agrep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult:
        return await (await self._ensure()).agrep(pattern, path, glob)

    async def aglob(self, pattern: str, path: str = "/") -> GlobResult:
        return await (await self._ensure()).aglob(pattern, path)

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return await (await self._ensure()).aupload_files(files)

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return await (await self._ensure()).adownload_files(paths)
