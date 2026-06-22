"""持久化（SQLite，内部工具够用，不进 Supabase）。

只剩一张 kv 表：存 app OAuth token、每个 issue 的 plan 草稿、awaiting-confirm 标记。
（早期"自动编排"设计的 pipeline_runs / pipeline_events 已随状态机一起退役——现在流程是
人在 Linear 里主动驱动，没有后台收敛循环要追踪的 run 状态。）
"""

from __future__ import annotations

import sqlite3
import time

_SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL
);
"""


class Store:
    def __init__(self, path: str = "dev_pipeline.sqlite") -> None:
        # check_same_thread=False：FastAPI 在线程池跑路由 + 后台任务，需跨线程读写。
        # 内部低并发工具，sqlite 自带锁足够；写操作都短小串行。
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def set_secret(self, key: str, value: str, now: float | None = None) -> None:
        ts = now if now is not None else time.time()
        self._conn.execute(
            "INSERT INTO kv(key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, ts),
        )
        self._conn.commit()

    def get_secret(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None
