#!/usr/bin/env python3
"""Seed pai_card_patterns + pai_card_pattern_demos from docs/data YAMLs.

The SSOT is `docs/data/patterns.yaml` + `docs/data/demo_cards.yaml` (see
docs/plans/2026-05-15-pattern-driven-card-generation.mdx). This script
upserts every pattern + demo into the DB so dashboards and seed
generator few-shot pools have data to work with.

Idempotent — safe to re-run; rows are upserted by primary key.

Usage:
    uv run python -m scripts.seed_patterns [--dsn DSN] [--dry-run]

Environment:
    DATABASE_URL  — fallback DSN when --dsn is omitted. Required unless --dsn is provided.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import yaml
from psycopg import AsyncConnection

REPO_ROOT = Path(__file__).resolve().parents[2]
PATTERNS_YAML = REPO_ROOT / "docs" / "data" / "patterns.yaml"
DEMOS_YAML = REPO_ROOT / "docs" / "data" / "demo_cards.yaml"

# Demo IDs are deterministic so re-runs upsert in place. The YAML doesn't
# carry a stable id; pattern_id + index within that pattern is enough.
def _demo_id(pattern_id: str, index: int) -> str:
    return f"demo:{pattern_id}:{index}"


def _load_yaml(path: Path) -> Any:
    if not path.exists():
        msg = f"missing: {path}"
        raise FileNotFoundError(msg)
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _coerce_pattern_row(raw: dict[str, Any]) -> dict[str, Any]:
    pattern_id = raw.get("id")
    if not isinstance(pattern_id, str) or not pattern_id:
        msg = f"pattern missing id: {raw!r}"
        raise ValueError(msg)
    skeleton = raw.get("card_skeleton") or {}
    skeleton = {} if not isinstance(skeleton, dict) else dict(skeleton)
    title_strategy = raw.get("title_strategy")
    if isinstance(title_strategy, dict):
        skeleton["title_strategy"] = title_strategy
    return {
        "id": pattern_id,
        "category": str(raw.get("category") or "uncategorized"),
        "abstract": str(raw.get("abstract") or ""),
        "human_insight": str(raw.get("human_insight") or ""),
        "signals_required": raw.get("signals") or [],
        "trigger_dsl": raw.get("trigger") or [],
        "intent": str(raw.get("intent") or "unknown"),
        "card_skeleton": skeleton,
        "specializations": raw.get("specializations") or [],
        "surprise_init": raw.get("surprise"),
        "practical_init": raw.get("practical"),
        "tier": str(raw.get("tier") or "warmup"),
        "status": "active",
        "source": "seed",
    }


def _coerce_demo_row(
    raw: dict[str, Any], *, demo_id: str, default_pattern_id: str | None = None,
) -> dict[str, Any]:
    pattern_id = raw.get("pattern_id") or default_pattern_id
    if not isinstance(pattern_id, str) or not pattern_id:
        msg = f"demo missing pattern_id: {raw!r}"
        raise ValueError(msg)
    card = raw.get("card") or {}
    if not isinstance(card, dict):
        card = {}
    card_json = dict(card)
    card_category = raw.get("card_category")
    if isinstance(card_category, str) and card_category.strip():
        card_json["cardCategory"] = card_category.strip()
    human_need = raw.get("human_need")
    if isinstance(human_need, str) and human_need.strip():
        card_json["humanNeed"] = human_need.strip()
    entry_point = raw.get("entry_point")
    if isinstance(entry_point, str) and entry_point.strip():
        card_json["entryPoint"] = entry_point.strip()
    source_data = raw.get("source_data")
    if source_data and "sourceData" not in card_json:
        card_json["sourceData"] = source_data
    return {
        "id": demo_id,
        "pattern_id": pattern_id,
        "subtype": raw.get("subtype"),
        "scenario": str(raw.get("scenario") or ""),
        "card_json": card_json,
        "signals_used": raw.get("signals_used") or [],
        "why_surprise": raw.get("why_surprise"),
        "why_practical": raw.get("why_practical"),
        "wow_level": raw.get("wow_level"),
        "source": "seed",
        "redacted": True,
    }


async def _upsert_patterns(conn: AsyncConnection, patterns: list[dict[str, Any]]) -> int:
    async with conn.cursor() as cur:
        for row in patterns:
            await cur.execute(
                """
                INSERT INTO pai_card_patterns
                  (id, category, abstract, human_insight, signals_required, trigger_dsl, intent,
                   card_skeleton, specializations, surprise_init, practical_init,
                   tier, status, source)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s,
                        %s::jsonb, %s::jsonb, %s, %s,
                        %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                  category = EXCLUDED.category,
                  abstract = EXCLUDED.abstract,
                  human_insight = EXCLUDED.human_insight,
                  signals_required = EXCLUDED.signals_required,
                  trigger_dsl = EXCLUDED.trigger_dsl,
                  intent = EXCLUDED.intent,
                  card_skeleton = EXCLUDED.card_skeleton,
                  specializations = EXCLUDED.specializations,
                  surprise_init = EXCLUDED.surprise_init,
                  practical_init = EXCLUDED.practical_init,
                  tier = EXCLUDED.tier,
                  status = EXCLUDED.status,
                  source = EXCLUDED.source,
                  updated_at = NOW()
                """,
                (
                    row["id"],
                    row["category"],
                    row["abstract"],
                    row["human_insight"],
                    json.dumps(row["signals_required"]),
                    json.dumps(row["trigger_dsl"]),
                    row["intent"],
                    json.dumps(row["card_skeleton"]),
                    json.dumps(row["specializations"]),
                    row["surprise_init"],
                    row["practical_init"],
                    row["tier"],
                    row["status"],
                    row["source"],
                ),
            )
    return len(patterns)


async def _upsert_demos(conn: AsyncConnection, demos: list[dict[str, Any]]) -> int:
    async with conn.cursor() as cur:
        for row in demos:
            await cur.execute(
                """
                INSERT INTO pai_card_pattern_demos
                  (id, pattern_id, subtype, scenario, card_json, signals_used,
                   why_surprise, why_practical, wow_level, source, redacted)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb,
                        %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                  pattern_id = EXCLUDED.pattern_id,
                  subtype = EXCLUDED.subtype,
                  scenario = EXCLUDED.scenario,
                  card_json = EXCLUDED.card_json,
                  signals_used = EXCLUDED.signals_used,
                  why_surprise = EXCLUDED.why_surprise,
                  why_practical = EXCLUDED.why_practical,
                  wow_level = EXCLUDED.wow_level,
                  source = EXCLUDED.source,
                  redacted = EXCLUDED.redacted
                """,
                (
                    row["id"],
                    row["pattern_id"],
                    row["subtype"],
                    row["scenario"],
                    json.dumps(row["card_json"], ensure_ascii=False),
                    json.dumps(row["signals_used"]),
                    row["why_surprise"],
                    row["why_practical"],
                    row["wow_level"],
                    row["source"],
                    row["redacted"],
                ),
            )
    return len(demos)


def _build_demo_rows(demos_yaml: dict[str, Any]) -> list[dict[str, Any]]:
    demos = demos_yaml.get("demos") or []
    if not isinstance(demos, list):
        msg = "demos must be a list"
        raise ValueError(msg)
    counts: dict[str, int] = {}
    rows: list[dict[str, Any]] = []
    for raw in demos:
        if not isinstance(raw, dict):
            continue
        pattern_id = raw.get("pattern_id")
        if not isinstance(pattern_id, str):
            continue
        idx = counts.get(pattern_id, 0)
        counts[pattern_id] = idx + 1
        rows.append(_coerce_demo_row(raw, demo_id=_demo_id(pattern_id, idx)))
    return rows


def _build_pattern_rows(patterns_yaml: dict[str, Any]) -> list[dict[str, Any]]:
    patterns = patterns_yaml.get("patterns") or []
    if not isinstance(patterns, list):
        msg = "patterns must be a list"
        raise ValueError(msg)
    return [_coerce_pattern_row(p) for p in patterns if isinstance(p, dict)]


async def _run(dsn: str, *, dry_run: bool = False) -> int:
    patterns_yaml = _load_yaml(PATTERNS_YAML)
    demos_yaml = _load_yaml(DEMOS_YAML)
    pattern_rows = _build_pattern_rows(patterns_yaml)
    demo_rows = _build_demo_rows(demos_yaml)

    print(f"parsed {len(pattern_rows)} patterns, {len(demo_rows)} demos")
    if dry_run:
        print("dry-run: not writing to DB")
        return 0

    async with (
        await AsyncConnection.connect(dsn) as conn,
        conn.transaction(),
    ):
        pat_count = await _upsert_patterns(conn, pattern_rows)
        demo_count = await _upsert_demos(conn, demo_rows)
    print(f"upserted patterns={pat_count} demos={demo_count}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed pai_card_patterns + demos from docs/data YAMLs.")
    parser.add_argument("--dsn", help="Postgres DSN; defaults to $DATABASE_URL")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, do not write")
    args = parser.parse_args()

    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn and not args.dry_run:
        print("DATABASE_URL or --dsn required", file=sys.stderr)
        return 2

    return asyncio.run(_run(dsn or "", dry_run=args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
