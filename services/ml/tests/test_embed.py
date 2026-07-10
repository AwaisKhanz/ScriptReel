import math
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app

client = TestClient(app)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def test_embed_text_normalized() -> None:
    res = client.post("/embed/text", json={"texts": ["a red sunset", "a blue ocean"]})
    assert res.status_code == 200
    body = res.json()
    assert body["dim"] == len(body["vectors"][0])
    for vec in body["vectors"]:
        assert abs(math.sqrt(sum(x * x for x in vec)) - 1.0) < 1e-3  # L2-normalized


def test_embed_image_identical_and_discriminative() -> None:
    with tempfile.TemporaryDirectory() as d:
        red = Path(d) / "red.png"
        red_copy = Path(d) / "red_copy.png"  # different path, identical pixels
        blue = Path(d) / "blue.png"
        Image.new("RGB", (64, 64), (200, 20, 20)).save(red)
        Image.new("RGB", (64, 64), (200, 20, 20)).save(red_copy)
        Image.new("RGB", (64, 64), (20, 20, 200)).save(blue)

        res = client.post(
            "/embed/image", json={"paths": [str(red), str(red_copy), str(blue)]}
        )
        assert res.status_code == 200
        body = res.json()
        assert body["failed"] == []
        assert body["dim"] == 768
        v_red, v_red_copy, v_blue = body["vectors"]

        # doc 14 golden: identical image → cosine > 0.99
        same = _cosine(v_red, v_red_copy)
        assert same > 0.99, f"identical-image cosine {same} ≤ 0.99"
        # and the model discriminates: a different image is less similar
        assert _cosine(v_red, v_blue) < same


def test_embed_image_reports_failed_paths() -> None:
    res = client.post("/embed/image", json={"paths": ["/nonexistent/nope.jpg"]})
    assert res.status_code == 200
    assert res.json()["failed"] == ["/nonexistent/nope.jpg"]
