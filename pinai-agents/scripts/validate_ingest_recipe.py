#!/usr/bin/env python3
"""Validate an ingest recipe by dry-running it against a real Composio
account.

Usage:
    .venv/bin/python -m scripts.validate_ingest_recipe <toolkit> \
        --user-id <pinai_internal_user_id> \
        --connected-account-id <ca_xxx> \
        [--since 2026-05-01T00:00:00+00:00] \
        [--limit 10]

What it does:
  1. Loads `db/ingest_recipes/<toolkit>.yaml`.
  2. Calls `services.ingest_runner.run_fetch(...)`.
  3. Prints item count + the first item (for shape sanity-check).
  4. Exits 0 if items > 0, 1 otherwise (so CI can wire this into a
     gate per-toolkit if we want).

Requires:
  * COMPOSIO_API_KEY in the environment
  * Connected account already linked for `<user-id>` on this toolkit
  * DATABASE_URL is NOT required — runner only talks to Composio
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path


def _setup_path() -> None:
    """Add `src/` to path so the script runs without `pip install -e`."""
    root = Path(__file__).resolve().parents[1]
    src = root / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))


_setup_path()

from pinai_agents.web.services import ingest_runner as ir  # noqa: E402


async def _main(args: argparse.Namespace) -> int:
    recipe = ir.load_recipe(args.toolkit)
    if recipe is None:
        print(f"❌ no recipe found for {args.toolkit}", file=sys.stderr)
        return 1

    if not recipe.is_ingestable():
        print(f"ℹ {args.toolkit} is connect_only — ingest skipped by design")
        return 0

    since: datetime | None = None
    if args.since:
        since = datetime.fromisoformat(args.since)

    print(f"→ fetching {args.toolkit} for user_id={args.user_id} "
          f"cid={args.connected_account_id} since={since}")

    items = await ir.run_fetch(
        args.user_id, args.toolkit, args.connected_account_id,
        limit=args.limit, since=since,
    )

    print(f"✓ got {len(items)} items")
    if items:
        sample = items[0]
        # Print the first 1k chars so we don't spam terminals on big payloads.
        text = json.dumps(sample, default=str, indent=2, ensure_ascii=False)
        print("  first item:")
        print("    " + text.replace("\n", "\n    ")[:1000])
        if recipe.id_field:
            id_val = sample.get(recipe.id_field)
            print(f"  id_field '{recipe.id_field}' = {id_val!r}")
        return 0

    print("⚠ no items — recipe may be drifting or account may be empty")
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate an ingest recipe.")
    parser.add_argument("toolkit", help="toolkit slug, e.g. gmail")
    parser.add_argument("--user-id", type=int, required=True,
                        help="pinai internal user id")
    parser.add_argument("--connected-account-id", required=True,
                        help="Composio connected account id (ca_xxx)")
    parser.add_argument("--since", default=None,
                        help="ISO datetime cursor (e.g. 2026-05-01T00:00:00+00:00)")
    parser.add_argument("--limit", type=int, default=100,
                        help="max items to fetch (passed to runner)")
    args = parser.parse_args()
    sys.exit(asyncio.run(_main(args)))


if __name__ == "__main__":
    main()
