"""Sync a dotenvx-encrypted .env file to a fly app's secrets.

Used by `.github/workflows/deploy-test.yml` before each pinai-agents
test deploy. Also runnable locally for emergency rotation:

    cd pinai-agents
    DOTENV_PRIVATE_KEY_TEST=... \\
      python scripts/sync_fly_secrets.py \\
        --app proactive-ai-agents-test \\
        --env-file .env.test

Behavior: secrets travel only via stdin pipe to `flyctl secrets
import` — they never appear in argv, so no Python traceback or shell
trace can leak them. Default `--stage` so the next `flyctl deploy`
applies them atomically with the image.

NOTE: per-process-group secrets are not supported by flyctl
(verified on 0.4.48 — `flyctl secrets set --help` has no such flag).
fly secrets are app-level and visible to every process group. The
trust boundary previously planned in chat/trust_boundary.py is
TEMPORARILY DISABLED — see chat/asgi.py for the commented-out boot
guard. When/if web and chat split into separate fly apps, the
import here can scope to one app each, and the boot guard re-enables.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def _decrypt_env(env_file: str) -> dict[str, str]:
    """Returns {key: value} for the given dotenvx-encrypted file.

    Caller must have the matching DOTENV_PRIVATE_KEY_<ENV> in the
    environment — dotenvx picks it up automatically.
    """
    raw = subprocess.check_output(
        ["npx", "@dotenvx/dotenvx", "get", "-f", env_file, "--format", "json"],
        text=True,
    )
    decoded = json.loads(raw)
    return {k: v for k, v in decoded.items() if not k.startswith("DOTENV_PUBLIC_KEY")}


def _flyctl_import(app: str, kvs: dict[str, str], *, stage: bool) -> None:
    """Pipe KEY=VAL\\n lines into `flyctl secrets import` via stdin.

    secrets never enter argv. If flyctl exits non-zero we sys.exit
    with a deliberately scrubbed message — the default Python traceback
    would echo subprocess.run's args, which is the leak vector that
    burned us in the previous run.
    """
    payload = "".join(f"{k}={v}\n" for k, v in kvs.items())
    args = ["flyctl", "secrets", "import", "--app", app]
    if stage:
        args.append("--stage")
    try:
        subprocess.run(args, input=payload, text=True, check=True)
    except subprocess.CalledProcessError as exc:
        sys.exit(
            f"ERROR: flyctl secrets import exited {exc.returncode} for app={app} (stdin contained {len(kvs)} secrets — not echoed)"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, help="Fly app name, e.g. proactive-ai-agents-test")
    parser.add_argument(
        "--env-file", required=True, help="dotenvx-encrypted file path, e.g. .env.test"
    )
    parser.add_argument(
        "--no-stage",
        action="store_true",
        help="Apply immediately instead of staging (triggers a fly redeploy).",
    )
    args = parser.parse_args()

    kvs = _decrypt_env(args.env_file)
    if not kvs:
        print(
            f"ERROR: no decrypted entries from {args.env_file} — check DOTENV_PRIVATE_KEY_*",
            file=sys.stderr,
        )
        return 1

    print(f"Source: {args.env_file} ({len(kvs)} keys after dotenvx decode)")
    print(f"Importing into {args.app} (app-level — both web and chat process groups)")
    print(f"Keys: {sorted(kvs)}")

    stage = not args.no_stage
    _flyctl_import(args.app, kvs, stage=stage)

    suffix = "(staged — apply on next `flyctl deploy`)" if stage else "(applied immediately)"
    print(f"OK {suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
