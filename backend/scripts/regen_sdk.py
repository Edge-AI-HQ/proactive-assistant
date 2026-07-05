#!/usr/bin/env python3
"""pinai_sdk packaging + contract guard.

The SDK lives at `packages/pinai_sdk/` as a standalone wheel-buildable
package. It's installed into the Daytona sandbox image (see
`infra/daytona/Dockerfile` and `chat/tools/code_mode/sandbox.py`) so
sandbox-side `from pinai_sdk import client` works at agent runtime.

It is hand-written on purpose and stays that way: object-style
(`client.events.search()`), which every Code Mode script + SDK_CHEAT_SHEET
depends on. `openapi-python-client` emits a function-style API that would
break all of that, so there is NO codegen step (plan 2026-06-02 §PR-A
overturned the original codegen idea).

Drift against the real `/api/agent/*` endpoints is guarded by tests instead:
  - `tests/web/test_sdk_contract.py` — each sdk resource maps to a live web
    endpoint group (sdk ↔ endpoint contract).
  - `tests/chat/test_sdk_cheat_sheet_sync.py` — SDK_CHEAT_SHEET ↔ sdk surface.

Run with --check to verify the SDK source exists, has the expected
namespaces, and the wheel builds cleanly (CI guard against accidental
deletion / a broken package).
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SDK_DIR = REPO_ROOT / "packages" / "pinai_sdk"


def _check() -> int:
    if not SDK_DIR.exists():
        print(f"FAIL: {SDK_DIR} missing", file=sys.stderr)
        return 1
    pyproject = SDK_DIR / "pyproject.toml"
    if not pyproject.exists():
        print(f"FAIL: {pyproject} missing", file=sys.stderr)
        return 1

    # Import directly from the package source (don't rely on it being
    # installed — the chat process doesn't install it; sandbox does).
    init_path = SDK_DIR / "src" / "pinai_sdk" / "__init__.py"
    if not init_path.exists():
        print(f"FAIL: {init_path} missing", file=sys.stderr)
        return 1
    spec = importlib.util.spec_from_file_location(
        "pinai_sdk",
        init_path,
        submodule_search_locations=[str(SDK_DIR / "src" / "pinai_sdk")],
    )
    if spec is None or spec.loader is None:
        print("FAIL: could not load pinai_sdk spec", file=sys.stderr)
        return 1
    mod = importlib.util.module_from_spec(spec)
    sys.modules["pinai_sdk"] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        print(f"FAIL: pinai_sdk import failed: {e}", file=sys.stderr)
        return 1
    client = getattr(mod, "client", None)
    if client is None:
        print("FAIL: pinai_sdk.client missing", file=sys.stderr)
        return 1
    for ns in ("events", "user_strings", "world", "raw", "cards", "feedback"):
        if not hasattr(client, ns):
            print(f"FAIL: pinai_sdk.client.{ns} missing", file=sys.stderr)
            return 1
    # raw.list is the canonical raw entry; raw.<toolkit> for unknown
    # toolkits must NOT exist (prior __getattr__ magic taught agents to
    # invent methods like raw.slack.messages).
    if not hasattr(client.raw, "list"):
        print("FAIL: pinai_sdk.client.raw.list missing", file=sys.stderr)
        return 1
    if hasattr(client.raw, "slack") or hasattr(client.raw, "github"):
        print(
            "FAIL: pinai_sdk.client.raw.<unknown-toolkit> resolved — "
            "Raw.__getattr__ magic must stay removed",
            file=sys.stderr,
        )
        return 1
    cheat = getattr(mod, "SDK_CHEAT_SHEET", None)
    if not isinstance(cheat, str) or "client.raw" not in cheat:
        print("FAIL: pinai_sdk.SDK_CHEAT_SHEET missing or malformed", file=sys.stderr)
        return 1
    print("ok: pinai_sdk imports + namespaces + raw.list + cheat sheet present")
    return 0


def _build_wheel() -> int:
    """Build the wheel locally — confirms the package installable."""
    proc = subprocess.run(
        ["uv", "build", "--wheel"],
        cwd=SDK_DIR,
        check=False,
    )
    if proc.returncode != 0:
        print("FAIL: uv build --wheel failed", file=sys.stderr)
        return proc.returncode
    print("ok: pinai_sdk wheel built")
    return 0


def main() -> int:
    args = set(sys.argv[1:])
    if "--check" in args:
        return _check()
    if "--build-wheel" in args:
        return _build_wheel()
    print(__doc__)
    print("\nUse --check for source sanity, --build-wheel for wheel build.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
