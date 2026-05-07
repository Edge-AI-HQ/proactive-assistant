"""Sync a dotenvx-encrypted .env file to a fly app's secrets, splitting
per process group so the chat process never receives master creds.

Used by `.github/workflows/deploy-test.yml` before each pinai-agents
test deploy. Also runnable locally for emergency rotation:

    cd pinai-agents
    DOTENV_PRIVATE_KEY_TEST=... \\
      python scripts/sync_fly_secrets.py \\
        --app proactive-ai-agents-test \\
        --env-file .env.test

The forbidden-for-chat list is imported from
`pinai_agents.chat.trust_boundary` — that module is the single source
of truth, kept side-effect free precisely so this script can import
it without booting the chat app.

Default behavior: stages secrets via `flyctl secrets set --stage` so
the caller's subsequent `flyctl deploy` applies them atomically with
the new image. Use `--no-stage` to apply immediately (which triggers
an immediate fly redeploy on its own).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Iterable

from pinai_agents.chat.trust_boundary import FORBIDDEN_ENVS


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


def _flyctl_set(
    app: str,
    process_group: str,
    kvs: Iterable[tuple[str, str]],
    *,
    stage: bool,
) -> None:
    args = ["flyctl", "secrets", "set", "--app", app, f"--process-group={process_group}"]
    if stage:
        args.append("--stage")
    args.extend(f"{k}={v}" for k, v in kvs)
    # subprocess.run handles arg quoting; values with spaces / quotes / newlines
    # are passed through cleanly because we never go through a shell.
    subprocess.run(args, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, help="Fly app name, e.g. proactive-ai-agents-test")
    parser.add_argument("--env-file", required=True, help="dotenvx-encrypted file path, e.g. .env.test")
    parser.add_argument(
        "--no-stage",
        action="store_true",
        help="Apply immediately instead of staging (triggers a fly redeploy).",
    )
    args = parser.parse_args()

    kvs = _decrypt_env(args.env_file)
    if not kvs:
        print(f"ERROR: no decrypted entries from {args.env_file} — check DOTENV_PRIVATE_KEY_*", file=sys.stderr)
        return 1

    forbidden = set(FORBIDDEN_ENVS)
    web_kvs = list(kvs.items())
    chat_kvs = [(k, v) for k, v in kvs.items() if k not in forbidden]
    filtered = sorted(set(kvs) & forbidden)

    print(f"Source: {args.env_file} ({len(kvs)} keys after dotenvx decode)")
    print(f"Forbidden-for-chat (single source: trust_boundary.py): {sorted(forbidden)}")
    print(f"  → {args.app}/web:  {len(web_kvs)} keys")
    print(f"  → {args.app}/chat: {len(chat_kvs)} keys (filtered out {len(filtered)}: {filtered})")

    stage = not args.no_stage
    _flyctl_set(args.app, "web", web_kvs, stage=stage)
    _flyctl_set(args.app, "chat", chat_kvs, stage=stage)

    suffix = "(staged — apply on next `flyctl deploy`)" if stage else "(applied immediately)"
    print(f"OK {suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
