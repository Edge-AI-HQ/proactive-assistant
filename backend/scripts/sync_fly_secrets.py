"""Sync a dotenvx-encrypted .env file to a fly app's secrets.

Used by `.github/workflows/deploy-test.yml` before each backend
test deploy. Also runnable locally for emergency rotation:

    cd backend
    DOTENV_PRIVATE_KEY_TEST=... \\
      python scripts/sync_fly_secrets.py \\
        --app proactive-ai-agents-test \\
        --env-file .env.test

Behavior: secrets travel only via stdin pipe to `flyctl secrets
import` — they never appear in argv, so no Python traceback or shell
trace can leak them. Default `--stage` so the next `flyctl deploy`
applies them atomically with the image.

Per-app trust scoping (ready; used once the single app splits):
flyctl has NO per-process-group secret (verified on 0.4.48) — secrets
are app-level, visible to every process group. A single fly app
therefore cannot keep master credentials away from the engine process
group (its asgi.py boot guard stays gated OFF). The fix is separate
fly apps; this script scopes the secret set per app:

  * api app (trusted)      — full set (default, no flags).
  * engine app (untrusted) — ``--exclude-master`` drops FORBIDDEN_ENVS;
    ``--database-url-from ENGINE_DATABASE_URL`` swaps in the pai_chat
    scoped DSN so the engine never gets the superuser DATABASE_URL.
  * reward-dashboard app   — ``--exclude-master --database-url-from
    REWARD_DATABASE_URL`` (read-only role DSN).

    cd backend
    DOTENV_PRIVATE_KEY_DEV=... python scripts/sync_fly_secrets.py \\
      --app proactive-ai-engine-dev --env-file .env.dev \\
      --exclude-master --database-url-from ENGINE_DATABASE_URL

``FORBIDDEN_ENVS`` is duplicated below (``_FORBIDDEN_ENVS``): this
script runs under the CI runner's system python3 with no project venv,
so it cannot import ``agent_engine.trust_boundary``.
``test_sync_fly_secrets`` asserts the two copies stay identical.
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


# Duplicated from agent_engine.trust_boundary.FORBIDDEN_ENVS — see the
# module docstring (this runs under the CI runner's system python3 with no
# project venv). test_sync_fly_secrets asserts this stays identical to the SSOT.
_FORBIDDEN_ENVS: tuple[str, ...] = (
    "SUPABASE_SECRET_KEY",
    "PAI_JWT_SIGNING_KEY",
    "COMPOSIO_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "LITELLM_MASTER_KEY",
    "APNS_AUTH_KEY",
)

# Scoped-role DSN aliases. Each carries one non-superuser role's connection
# string; --database-url-from swaps the named one into DATABASE_URL. They are
# dropped from EVERY app so no app ever holds another app's scoped DSN (the
# engine must not see REWARD_DATABASE_URL, etc). Not master credentials, but
# least-privilege hygiene — keep in sync with the env files' DSN aliases.
_SCOPED_DSN_ALIASES: tuple[str, ...] = (
    "ENGINE_DATABASE_URL",
    "REWARD_DATABASE_URL",
    "APP_DATABASE_URL",
)


def _filter_for_app(
    kvs: dict[str, str],
    *,
    exclude_master: bool,
    database_url_from: str | None,
) -> dict[str, str]:
    """Scope the secret set for one fly app (see module docstring).

    ``exclude_master`` drops every master credential (engine / reward-dashboard
    apps). ``database_url_from`` swaps DATABASE_URL for the named scoped-role DSN
    and drops the alias key, so the superuser DSN never reaches the app.
    """
    out = dict(kvs)
    if exclude_master:
        for key in _FORBIDDEN_ENVS:
            out.pop(key, None)
    if database_url_from:
        scoped = kvs.get(database_url_from)
        if not scoped:
            sys.exit(
                f"ERROR: --database-url-from {database_url_from} not present in env file "
                f"(add the scoped-role DSN there before scoping this app)"
            )
        out["DATABASE_URL"] = scoped
    # Drop every scoped-role DSN alias from every app — the one named by
    # --database-url-from was swapped into DATABASE_URL above; the rest are
    # simply not this app's and must not cross the trust boundary.
    for alias in _SCOPED_DSN_ALIASES:
        out.pop(alias, None)
    return out


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
    parser.add_argument(
        "--exclude-master",
        action="store_true",
        help="Drop master credentials (FORBIDDEN_ENVS) — for the engine / "
        "reward-dashboard apps, which must never hold them.",
    )
    parser.add_argument(
        "--database-url-from",
        metavar="KEY",
        help="Swap DATABASE_URL for the scoped-role DSN under KEY (e.g. "
        "ENGINE_DATABASE_URL). Drops the alias so the superuser DSN never "
        "reaches the app.",
    )
    args = parser.parse_args()

    decrypted = _decrypt_env(args.env_file)
    if not decrypted:
        print(
            f"ERROR: no decrypted entries from {args.env_file} — check DOTENV_PRIVATE_KEY_*",
            file=sys.stderr,
        )
        return 1

    kvs = _filter_for_app(
        decrypted,
        exclude_master=args.exclude_master,
        database_url_from=args.database_url_from,
    )

    print(f"Source: {args.env_file} ({len(decrypted)} keys after dotenvx decode)")
    print(f"Importing into {args.app} ({len(kvs)} keys after app scoping)")
    if args.exclude_master:
        masked = sorted(k for k in _FORBIDDEN_ENVS if k in decrypted)
        print(f"  --exclude-master dropped: {masked}")
    if args.database_url_from:
        print(f"  --database-url-from: DATABASE_URL <- {args.database_url_from} (scoped DSN)")
    print(f"Keys: {sorted(kvs)}")

    stage = not args.no_stage
    _flyctl_import(args.app, kvs, stage=stage)

    suffix = "(staged — apply on next `flyctl deploy`)" if stage else "(applied immediately)"
    print(f"OK {suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
