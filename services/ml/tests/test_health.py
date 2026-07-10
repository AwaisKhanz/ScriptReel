from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["device"] in {"mps", "cpu", "cuda", "unavailable"}


def test_warmup_does_not_load_weights() -> None:
    res = client.post("/warmup")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["warmed"] is False
    assert "importable" in body
