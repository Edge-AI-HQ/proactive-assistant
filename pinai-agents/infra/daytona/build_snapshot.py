#!/usr/bin/env python3
"""Build + register the Pin AI Daytona snapshot via Python SDK.

Uses Daytona's declarative Image builder — equivalent to the Dockerfile
in this directory but built / uploaded directly through the Python SDK
so we don't need the daytona CLI installed.

Usage (from pinai-agents root):

    DAYTONA_API_KEY=$DAYTONA_API_KEY uv run python infra/daytona/build_snapshot.py
    DAYTONA_API_KEY=$DAYTONA_API_KEY uv run python infra/daytona/build_snapshot.py --version 0.2.0
    DAYTONA_API_KEY=$DAYTONA_API_KEY uv run python infra/daytona/build_snapshot.py --recreate

Default version comes from packages/pinai_sdk/pyproject.toml so a SDK
version bump triggers a snapshot bump too.

After this finishes, set PINAI_DAYTONA_SNAPSHOT=pinai-sandbox:<version>
in pinai-chat's env (docker-compose.yml / fly secrets) and chat agents
will create sandboxes from the new snapshot.

References:
  https://www.daytona.io/docs/en/declarative-builder/
  https://www.daytona.io/docs/en/snapshots/
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import daytona

REPO_ROOT = Path(__file__).resolve().parents[2]
SDK_DIR = REPO_ROOT / "packages" / "pinai_sdk"


def _read_sdk_version() -> str:
    pyproject = (SDK_DIR / "pyproject.toml").read_text()
    m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    if not m:
        msg = "could not find version in packages/pinai_sdk/pyproject.toml"
        raise RuntimeError(msg)
    return m.group(1)


def _build_image() -> daytona.Image:
    """Mirror of infra/daytona/Dockerfile, declarative-builder form.

    Pinned major versions to avoid silent drift; only-binary install
    skips compilation steps so build stays fast.
    """
    return (
        daytona.Image
        .debian_slim("3.12")
        .pip_install([
            "httpx>=0.27.0,<1.0",
            "pydantic>=2.6.0,<3.0",
            "anyio>=4.0.0,<5.0",
            "orjson>=3.10.0,<4.0",
        ])
        # Upload local SDK dir + install. Path is relative to the cwd
        # process_image_context() runs from — i.e. wherever this script
        # gets invoked. We chdir to REPO_ROOT below to make this stable.
        .add_local_dir(str(SDK_DIR), "/opt/pinai_sdk")
        # NOTE: positional args, NOT a list — Daytona's run_commands
        # treats a list as Docker exec-form which mangles shell quoting.
        .run_commands(
            "pip install --no-cache-dir /opt/pinai_sdk",
            # Smoke check: snapshot build fails if pinai_sdk is unhealthy.
            "python3 -c 'from pinai_sdk import client; print(\"pinai_sdk preinstalled\")'",
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version", default=None,
        help="Snapshot tag (default: read from packages/pinai_sdk/pyproject.toml)",
    )
    parser.add_argument(
        "--recreate", action="store_true",
        help="Delete existing snapshot with same name before creating",
    )
    args = parser.parse_args()

    if not os.environ.get("DAYTONA_API_KEY"):
        print("FATAL: DAYTONA_API_KEY not set", file=sys.stderr)
        return 1

    os.chdir(REPO_ROOT)
    version = args.version or _read_sdk_version()
    name = f"pinai-sandbox:{version}"
    print(f"→ building Daytona snapshot {name}")
    print(f"  cwd:           {Path.cwd()}")
    print(f"  sdk dir:       {SDK_DIR.relative_to(REPO_ROOT)}")

    sdk = daytona.Daytona()

    if args.recreate:
        try:
            existing = sdk.snapshot.get(name)
            if existing:
                print(f"  → deleting existing snapshot {name}")
                sdk.snapshot.delete(existing)
        except Exception as e:
            # Most likely "not found" — fine.
            print(f"  (no prior snapshot to delete: {type(e).__name__})")

    image = _build_image()
    snap = sdk.snapshot.create(
        daytona.CreateSnapshotParams(
            name=name,
            image=image,
            resources=daytona.Resources(cpu=2, memory=4, disk=8),
        ),
        on_logs=lambda line: print(f"  [build] {line}", flush=True),
        timeout=600,
    )
    print(f"→ snapshot {snap.name} registered (state={snap.state})")
    print()
    print("Next:")
    print(f'  set PINAI_DAYTONA_SNAPSHOT="{name}" on pinai-chat')
    print("  (docker-compose.yml pinai-chat env, or fly secrets set)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
