#!/usr/bin/env python3
"""Clean duplicate transcript candidate windows in pai_personal_signals.

Default mode is dry-run. Pass --apply to:
  1. keep the freshest row per (user_id, device_id, local_date, local_window_id);
  2. delete older duplicates;
  3. normalize the kept row's dedupe_key to the canonical transcript-window key;
  4. remove "Transcript segment:" labels from summary / payload.compact_context.

Freshest = largest payload.raw_ref_count, then newest ingested_at.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import psycopg
from psycopg.rows import dict_row

CANDIDATES_SQL = """
WITH candidates AS (
  SELECT
    user_id,
    id,
    dedupe_key,
    device_id,
    status,
    summary,
    btrim(regexp_replace(
      regexp_replace(summary, 'Transcript segment:\\s*', '', 'g'),
      '\\s+', ' ', 'g'
    )) AS clean_summary,
    payload ->> 'local_date' AS local_date,
    payload ->> 'local_window_id' AS local_window_id,
    payload ->> 'compact_context' AS compact_context,
    btrim(regexp_replace(
      regexp_replace(COALESCE(payload ->> 'compact_context', ''), 'Transcript segment:\\s*', '', 'g'),
      '\\s+', ' ', 'g'
    )) AS clean_compact_context,
    CASE
      WHEN payload ->> 'raw_ref_count' ~ '^[0-9]+$'
        THEN (payload ->> 'raw_ref_count')::integer
      ELSE 0
    END AS raw_ref_count,
    payload ->> 'content_hash' AS content_hash,
    ingested_at
  FROM pai_personal_signals
  WHERE kind = 'ambient.candidate_window'
    AND payload ->> 'window_type' = 'transcript_session'
    AND NULLIF(payload ->> 'local_date', '') IS NOT NULL
    AND NULLIF(payload ->> 'local_window_id', '') IS NOT NULL
),
ranked AS (
  SELECT
    *,
    CASE
      WHEN device_id IS NOT NULL AND device_id <> ''
        THEN 'ambient:candidate_window:' || device_id || ':' || local_date
             || ':transcript_session:' || local_window_id
      ELSE 'ambient:candidate_window:' || local_date
             || ':transcript_session:' || local_window_id
    END AS canonical_key,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, COALESCE(device_id, ''), local_date, local_window_id
      ORDER BY raw_ref_count DESC, ingested_at DESC, id DESC
    ) AS rn,
    COUNT(*) OVER (
      PARTITION BY user_id, COALESCE(device_id, ''), local_date, local_window_id
    ) AS group_count
  FROM candidates
)
SELECT *
FROM ranked
WHERE group_count > 1
   OR dedupe_key IS DISTINCT FROM canonical_key
   OR summary LIKE '%Transcript segment:%'
   OR compact_context LIKE '%Transcript segment:%'
ORDER BY user_id, COALESCE(device_id, ''), local_date, local_window_id, rn
"""


APPLY_STATEMENTS = [
    """
    CREATE TEMP TABLE transcript_window_cleanup_ranked ON COMMIT DROP AS
    WITH candidates AS (
      SELECT
        user_id,
        id,
        dedupe_key,
        device_id,
        summary,
        btrim(regexp_replace(
          regexp_replace(summary, 'Transcript segment:\\s*', '', 'g'),
          '\\s+', ' ', 'g'
        )) AS clean_summary,
        payload ->> 'local_date' AS local_date,
        payload ->> 'local_window_id' AS local_window_id,
        payload ->> 'compact_context' AS compact_context,
        btrim(regexp_replace(
          regexp_replace(COALESCE(payload ->> 'compact_context', ''), 'Transcript segment:\\s*', '', 'g'),
          '\\s+', ' ', 'g'
        )) AS clean_compact_context,
        CASE
          WHEN payload ->> 'raw_ref_count' ~ '^[0-9]+$'
            THEN (payload ->> 'raw_ref_count')::integer
          ELSE 0
        END AS raw_ref_count,
        ingested_at
      FROM pai_personal_signals
      WHERE kind = 'ambient.candidate_window'
        AND payload ->> 'window_type' = 'transcript_session'
        AND NULLIF(payload ->> 'local_date', '') IS NOT NULL
        AND NULLIF(payload ->> 'local_window_id', '') IS NOT NULL
    )
    SELECT
      *,
      CASE
        WHEN device_id IS NOT NULL AND device_id <> ''
          THEN 'ambient:candidate_window:' || device_id || ':' || local_date
               || ':transcript_session:' || local_window_id
        ELSE 'ambient:candidate_window:' || local_date
               || ':transcript_session:' || local_window_id
      END AS canonical_key,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, COALESCE(device_id, ''), local_date, local_window_id
        ORDER BY raw_ref_count DESC, ingested_at DESC, id DESC
      ) AS rn
    FROM candidates
    """,
    """
    DELETE FROM pai_personal_signals p
    USING transcript_window_cleanup_ranked r
    WHERE p.user_id = r.user_id
      AND p.id = r.id
      AND r.rn > 1
    """,
    """
    UPDATE pai_personal_signals p
    SET
      dedupe_key = r.canonical_key,
      summary = CASE
        WHEN r.clean_summary <> '' THEN r.clean_summary
        ELSE p.summary
      END,
      payload = CASE
        WHEN p.summary LIKE '%Transcript segment:%'
          OR p.payload ->> 'compact_context' LIKE '%Transcript segment:%'
        THEN (
          CASE
            WHEN r.compact_context IS NOT NULL AND r.clean_compact_context <> ''
              THEN jsonb_set(p.payload, '{compact_context}', to_jsonb(r.clean_compact_context), true)
            ELSE p.payload
          END
        ) - 'content_hash'
        ELSE p.payload
      END,
      updated_at = NOW()
    FROM transcript_window_cleanup_ranked r
    WHERE p.user_id = r.user_id
      AND p.id = r.id
      AND r.rn = 1
      AND (
        p.dedupe_key IS DISTINCT FROM r.canonical_key
        OR p.summary LIKE '%Transcript segment:%'
        OR p.payload ->> 'compact_context' LIKE '%Transcript segment:%'
      )
    """,
]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    if not args.dsn:
        print("DATABASE_URL or --dsn required", file=sys.stderr)
        return 2

    with psycopg.connect(args.dsn, row_factory=dict_row) as conn, conn.cursor() as cur:
        cur.execute(CANDIDATES_SQL)
        rows = cur.fetchall()
        print_report(rows)
        if not args.apply:
            print("dry-run only; pass --apply to modify rows")
            return 0
        for statement in APPLY_STATEMENTS:
            cur.execute(statement)
        print("applied cleanup")
    return 0


def print_report(rows: list[dict[str, Any]]) -> None:
    duplicate_rows = [row for row in rows if row["group_count"] > 1 and row["rn"] > 1]
    normalize_rows = [
        row for row in rows if row["rn"] == 1 and row["dedupe_key"] != row["canonical_key"]
    ]
    clean_rows = [
        row
        for row in rows
        if row["rn"] == 1
        and (
            "Transcript segment:" in (row["summary"] or "")
            or "Transcript segment:" in (row["compact_context"] or "")
        )
    ]
    print(f"candidate rows needing attention: {len(rows)}")
    print(f"duplicate rows that would be deleted: {len(duplicate_rows)}")
    print(f"kept rows that would get canonical dedupe_key: {len(normalize_rows)}")
    print(f"kept rows that would get clean summary text: {len(clean_rows)}")
    for row in rows[:50]:
        marker = "keep" if row["rn"] == 1 else "drop"
        print(
            f"{marker} user={row['user_id']} device={row['device_id'] or '-'} "
            f"date={row['local_date']} window={row['local_window_id']} "
            f"raw_refs={row['raw_ref_count']} status={row['status']} "
            f"dedupe={row['dedupe_key']}",
        )
    if len(rows) > 50:
        print(f"... truncated {len(rows) - 50} rows")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
