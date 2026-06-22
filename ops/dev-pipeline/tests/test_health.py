from fastapi.testclient import TestClient

from dev_pipeline.app import create_app


def test_healthz() -> None:
    client = TestClient(create_app())
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "dev-pipeline"
