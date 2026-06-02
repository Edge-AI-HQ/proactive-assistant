"""Local DeepAgents backend for no-tunnel development runs."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from deepagents.backends.local_shell import LocalShellBackend


def use_local_sandbox() -> bool:
    return os.environ.get("PINAI_LOCAL_SANDBOX", "").lower() in {"1", "true", "yes"}


def local_chat_root_dir(thread_id: str) -> Path:
    """Stable per-thread workspace under /state for local chat tests."""
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", thread_id).strip(".-") or "thread"
    if len(safe) > 80:
        digest = hashlib.sha1(thread_id.encode("utf-8")).hexdigest()[:10]
        safe = f"{safe[:69]}-{digest}"
    return Path("/state/chat") / safe


def create_local_sandbox_backend(
    *,
    run_jwt: str,
    root_dir: str | Path,
    reset_files: tuple[str, ...] = (),
) -> LocalShellBackend:
    """Create a LocalShellBackend that can call pinai-web over Docker DNS."""
    root = Path(root_dir)
    root.mkdir(parents=True, exist_ok=True)
    for name in reset_files:
        (root / name).unlink(missing_ok=True)

    path = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    pythonpath = os.environ.get("PYTHONPATH", "")
    sdk_path = "/app/packages/pinai_sdk/src"
    if sdk_path not in pythonpath.split(":"):
        pythonpath = f"{sdk_path}:{pythonpath}" if pythonpath else sdk_path

    return LocalShellBackend(
        root_dir=str(root),
        virtual_mode=False,
        timeout=5 * 60,
        inherit_env=True,
        env={
            "PATH": f"/app/.venv/bin:{path}",
            "PYTHONPATH": pythonpath,
            "PAI_API_URL": os.environ.get("WEB_INTERNAL_URL", "http://pinai-web:8000"),
            "PAI_RUN_JWT": run_jwt,
        },
    )
