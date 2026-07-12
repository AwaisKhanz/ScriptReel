import asyncio

import pytest

# Skip the whole module unless InsightFace is importable AND its model pack loads.
# These tests are NOT part of `pnpm check` — they run only where the identity models
# are set up (`make fetch-identity`); a machine without them skips cleanly.
pytest.importorskip("insightface")

from app import face  # noqa: E402

pytestmark = pytest.mark.skipif(not face.available(), reason="insightface buffalo_l not installed")


def test_embed_faces_empty_is_noop() -> None:
    vectors, dim, failed = asyncio.run(face.embed_faces([]))
    assert vectors == []
    assert dim == 512
    assert failed == []


def test_embed_faces_reports_faceless_image() -> None:
    import tempfile
    from pathlib import Path

    from PIL import Image

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "blank.png"
        Image.new("RGB", (320, 320), (128, 128, 128)).save(p)
        vectors, dim, failed = asyncio.run(face.embed_faces([str(p)]))
        assert dim == 512
        # A flat gray image has no detectable face → reported as failed, never fatal.
        assert failed == [str(p)]
        assert len(vectors) == 1
        assert len(vectors[0]) == 512
