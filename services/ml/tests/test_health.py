from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["device"] in {"mps", "cpu", "cuda", "unavailable"}
    assert "kokoro" in body["models"]


def test_warmup_no_langs_does_not_load_models() -> None:
    res = client.post("/warmup", json={"langs": []})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["warmedLangs"] == []
    assert "importable" in body
