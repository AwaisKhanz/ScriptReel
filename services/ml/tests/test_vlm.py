"""Unit tests for the VLM checklist pure helpers (doc 25 §5-D).

``_parse_checklist`` and ``_checklist_prompt`` carry no model state, so — unlike
test_dino.py's model-gated cases — these run WITHOUT the Qwen weights present. The
module imports cleanly whether or not mlx-vlm is installed (all heavy imports are
inside functions), so no importorskip / availability skip is needed here.
"""

from __future__ import annotations

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
