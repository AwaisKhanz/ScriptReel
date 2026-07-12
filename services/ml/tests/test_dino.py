import asyncio
import tempfile
from pathlib import Path

import pytest

# Skip the whole module unless transformers is importable AND the DINOv2 snapshot is
# present locally. These tests are NOT part of `pnpm check` — they run only where the
# identity models are set up (`make fetch-identity`); a machine without them skips.
pytest.importorskip("transformers")

from app import dino  # noqa: E402

pytestmark = pytest.mark.skipif(not dino.available(), reason="DINOv2 snapshot not installed")


def test_embed_images_empty_is_noop() -> None:
    vectors, dim, failed = asyncio.run(dino.embed_images([]))
    assert vectors == []
    assert dim >= 1
    assert failed == []


def test_embed_images_shape_and_normalization() -> None:
    import numpy as np

    with tempfile.TemporaryDirectory() as d:
        from PIL import Image

        p = Path(d) / "img.png"
        Image.new("RGB", (256, 256), (40, 120, 200)).save(p)
        vectors, dim, failed = asyncio.run(dino.embed_images([str(p)]))
        assert failed == []
        assert len(vectors) == 1
        assert len(vectors[0]) == dim
        # CLS token is L2-normalized → unit norm.
        assert np.isclose(np.linalg.norm(vectors[0]), 1.0, atol=1e-3)


def test_embed_images_reports_unreadable_path() -> None:
    vectors, dim, failed = asyncio.run(dino.embed_images(["/nonexistent/nope.png"]))
    assert dim >= 1
    assert failed == ["/nonexistent/nope.png"]
    assert len(vectors) == 1
