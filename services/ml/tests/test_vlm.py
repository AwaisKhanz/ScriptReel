"""Unit tests for the VLM checklist pure helpers (doc 25 §5-D).

``_parse_checklist`` and ``_checklist_prompt`` carry no model state, so — unlike
test_dino.py's model-gated cases — these run WITHOUT the Qwen weights present. The
module imports cleanly whether or not mlx-vlm is installed (all heavy imports are
inside functions), so no importorskip / availability skip is needed here.
"""

from __future__ import annotations

import asyncio
from json import dumps as _dumps
from pathlib import Path
from unittest.mock import patch

import app.vlm as vlm
from app.vlm import _checklist_prompt, _parse_checklist


def test_parse_checklist_clean_json() -> None:
    parsed = _parse_checklist(
        '{"subject_present": false, "shot_type_matches": true, '
        '"era_matches": false, "contradicting_text": true}'
    )
    assert parsed == {
        "subject_present": False,
        "shot_type_matches": True,
        "era_matches": False,
        "contradicting_text": True,
    }


def test_parse_checklist_json_in_markdown() -> None:
    text = (
        "Here is my assessment:\n"
        "```json\n"
        '{"subject_present": true, "shot_type_matches": false, '
        '"era_matches": true, "contradicting_text": false}\n'
        "```\n"
        "Hope that helps!"
    )
    parsed = _parse_checklist(text)
    assert parsed is not None
    assert parsed["subject_present"] is True
    assert parsed["shot_type_matches"] is False
    assert parsed["era_matches"] is True
    assert parsed["contradicting_text"] is False


def test_parse_checklist_garbage_returns_none() -> None:
    assert _parse_checklist("I could not determine anything from this image.") is None
    assert _parse_checklist("") is None


def test_parse_checklist_missing_keys_use_conservative_defaults() -> None:
    # A parse gap must never veto: subject_present / era_matches / shot_type_matches
    # default True, contradicting_text defaults False.
    parsed = _parse_checklist('{"contradicting_text": true}')
    assert parsed == {
        "subject_present": True,
        "shot_type_matches": True,
        "era_matches": True,
        "contradicting_text": True,
    }


def test_parse_checklist_coerces_string_and_numeric_bools() -> None:
    parsed = _parse_checklist(
        '{"subject_present": "false", "shot_type_matches": "yes", '
        '"era_matches": 0, "contradicting_text": 1}'
    )
    assert parsed == {
        "subject_present": False,
        "shot_type_matches": True,
        "era_matches": False,
        "contradicting_text": True,
    }


def test_checklist_prompt_includes_description_and_demands_json() -> None:
    prompt = _checklist_prompt("Albert Einstein at a chalkboard", "historical")
    assert "Albert Einstein at a chalkboard" in prompt
    assert "historical" in prompt
    assert "ONLY the JSON object" in prompt
    # Each checklist field is named so the model knows the schema.
    for key in ("subject_present", "shot_type_matches", "era_matches", "contradicting_text"):
        assert key in prompt


def test_checklist_prompt_timeless_era_is_auto_true() -> None:
    prompt = _checklist_prompt("a soaring eagle over mountains", "timeless")
    # A timeless beat must not be penalized on era — the prompt tells the model so.
    assert "era-agnostic" in prompt


# --- Non-Apple (Ollama / LM Studio) backend -------------------------------------------------
# These drive the remote path directly (it's platform-agnostic code) with a mocked server, so
# they run on the Mac too even though run_vlm() would take the MLX branch here.


def _make_image(tmp_path: Path, size: tuple[int, int] = (2000, 1200)) -> str:
    from PIL import Image

    path = tmp_path / "cand.png"
    Image.new("RGB", size, (120, 60, 30)).save(path)
    return str(path)


class _FakeResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._payload


def test_encode_image_data_uri_is_resized_jpeg(tmp_path: Path) -> None:
    uri = vlm._encode_image_data_uri(_make_image(tmp_path))
    assert uri.startswith("data:image/jpeg;base64,")
    assert len(uri) > 100  # real payload, not an empty string


def test_run_vlm_remote_builds_openai_payload_and_maps_verdict(tmp_path: Path) -> None:
    path = _make_image(tmp_path)
    captured: list[tuple[str, dict]] = []

    class Client:
        def __init__(self, **_kw: object) -> None: ...
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_a: object) -> bool:
            return False

        async def post(self, url: str, json: dict | None = None) -> _FakeResp:
            captured.append((url, json or {}))
            verdict = {
                "subject_present": True,
                "shot_type_matches": True,
                "era_matches": False,
                "contradicting_text": False,
            }
            return _FakeResp({"choices": [{"message": {"content": _dumps(verdict)}}]})

    with patch("httpx.AsyncClient", return_value=Client()):
        results, failed = asyncio.run(
            vlm._run_vlm_remote([{"path": path, "description": "a red wall", "era": "1960s"}])
        )

    assert failed == []
    assert results == [
        {
            "path": path,
            "subjectPresent": True,
            "shotTypeMatches": True,
            "eraMatches": False,
            "contradictingText": False,
        }
    ]
    url, payload = captured[0]
    assert url == "/chat/completions"
    assert payload["model"] == vlm._REMOTE_MODEL
    content = payload["messages"][0]["content"]
    assert content[0]["type"] == "text" and "a red wall" in content[0]["text"]
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_run_vlm_remote_non_json_reply_goes_to_failed(tmp_path: Path) -> None:
    path = _make_image(tmp_path)

    class Client:
        def __init__(self, **_kw: object) -> None: ...
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *_a: object) -> bool:
            return False

        async def post(self, _url: str, json: dict | None = None) -> _FakeResp:
            return _FakeResp({"choices": [{"message": {"content": "I cannot answer."}}]})

    with patch("httpx.AsyncClient", return_value=Client()):
        results, failed = asyncio.run(
            vlm._run_vlm_remote([{"path": path, "description": "x", "era": "timeless"}])
        )
    assert results == [] and failed == [path]


def test_probe_remote_present_absent_and_down() -> None:
    present = _FakeResp({"data": [{"id": vlm._REMOTE_MODEL}, {"id": "llama3.2"}]})
    absent = _FakeResp({"data": [{"id": "llama3.2"}]})
    with patch("httpx.get", return_value=present):
        assert vlm._probe_remote() is True
    with patch("httpx.get", return_value=absent):
        assert vlm._probe_remote() is False
    with patch("httpx.get", side_effect=OSError("Connection refused")):
        assert vlm._probe_remote() is False
