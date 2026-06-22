"""Store kv：app token 等 secret 存取。"""

from __future__ import annotations

from dev_pipeline.store import Store


def test_set_get_secret() -> None:
    s = Store(":memory:")
    assert s.get_secret("k") is None
    s.set_secret("k", "v1", now=1.0)
    assert s.get_secret("k") == "v1"
    s.set_secret("k", "v2", now=2.0)  # upsert
    assert s.get_secret("k") == "v2"
    s.close()
