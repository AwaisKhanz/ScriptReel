"""Qwen2.5-VL-3B VLM checklist (doc 25 §5-D, cascade D).

After the OCR + reference-identity gates, the score stage sends each beat's top-3
SigLIP candidates here and asks a strict-JSON checklist — subject present? shot
framing appropriate? era matches? contradicting on-screen text? — so the survivor
is VLM-confirmed for subject, framing, era, and no contradicting text.

Two backends answer the SAME checklist, picked by platform so every OS runs the gate:
  - **Apple Silicon** → Qwen2.5-VL-3B 4-bit via **mlx-vlm** (load-on-demand, evicted after).
  - **Windows / Linux** → the same Qwen2.5-VL family via an **OpenAI-compatible local server**
    (Ollama by default, or LM Studio) — MLX has no Windows/Linux build, so we call out over
    HTTP instead of forcing an Apple-only library (see ``_run_vlm_remote``).
``available()`` probes the active backend WITHOUT side effects — the Apple path checks the
LOCAL HF cache (``local_files_only`` never downloads); the remote path pings the server. When
the backend isn't ready ``run_vlm`` raises ``VlmError`` (a 500 the worker catches) so the VLM
pass skips and the render is unchanged (invariant 7 — degrade, never die).

Unlike the resident light models (SigLIP / DINOv2 / InsightFace), the ~2.2 GB Qwen
weights are LOAD-ON-DEMAND + EVICTED after each batch (doc 25 §6) so the M3 Pro's
unified memory is never over-committed. An ``asyncio`` lock serialises the heavy,
memory-hungry batch so two never load at once.

The pure helpers ``_checklist_prompt`` and ``_parse_checklist`` carry no model state
and are unit-tested without the weights present (tests/test_vlm.py).
"""

from __future__ import annotations

import asyncio
import gc
import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor

from app.models import is_apple_silicon

_log = logging.getLogger("scriptreel.vlm")

MODEL_ID = os.environ.get("QWEN_VL_MODEL", "mlx-community/Qwen2.5-VL-3B-Instruct-4bit")

# --- Non-Apple VLM backend (Windows / Linux) --------------------------------------------------
# MLX is Apple-Silicon-only, so off-Apple the SAME checklist is answered by an OpenAI-compatible
# local server. Ollama by default (`ollama pull qwen2.5vl:3b` → the same Qwen2.5-VL family as the
# Apple path); point VLM_BASE_URL at LM Studio (http://localhost:1234/v1) or any OpenAI-compatible
# server to use that instead. This is a real backend, NOT a skip — Windows runs the VLM gate too.
_REMOTE_BASE_URL = os.environ.get("VLM_BASE_URL", "http://localhost:11434/v1").rstrip("/")
_REMOTE_MODEL = os.environ.get("VLM_REMOTE_MODEL", "qwen2.5vl:3b")
_REMOTE_API_KEY = os.environ.get("VLM_API_KEY", "ollama")  # Ollama ignores it; keep it non-empty
_REMOTE_TIMEOUT = float(os.environ.get("VLM_TIMEOUT_S", "120"))  # local generate can be slow on CPU
_REMOTE_PROBE_TIMEOUT = 3.0  # availability probe: fail fast when the server isn't up
_MAX_TOKENS = 128  # a yes/no checklist needs very few tokens; cap so a runaway can't stall
_MAX_SIDE = 1024  # cap resolution before generate: Qwen2.5-VL runs at native res, so a full-
#                   size image (e.g. a screenshot) explodes the vision tensor to multiple GB
#                   and trips a Metal OOM. Pipeline thumbnails (~384 px) pass through untouched.

_model: object | None = None
_processor: object | None = None
_config: object | None = None
_available_cache: bool | None = None  # one-time availability probe cache
_infer_lock = asyncio.Lock()

# mlx-vlm's Metal generation streams are THREAD-BOUND, and they collide with the torch-MPS /
# onnx state that the shared asyncio pool accumulates (FastAPI runs sync endpoints + the other
# models on that pool). Running generate on a contaminated pool thread raises "no Stream(gpu, 1)
# in current thread". So pin ALL mlx-vlm work (load + generate + evict) to ONE dedicated thread
# that never runs torch/onnx — its MLX context stays clean and consistent across calls.
_vlm_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vlm")


class VlmError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "E_VLM"


def available() -> bool:
    """True when the platform's VLM backend is ready.

    Apple Silicon → mlx-vlm + the local Qwen snapshot; cached both ways (install/download state
    is static within a process). Elsewhere → a reachable OpenAI-compatible server holding the
    model; only a POSITIVE result is cached, so the gate lights up the moment you start Ollama /
    LM Studio (no sidecar restart needed). A negative result ⇒ ``run_vlm`` raises ``VlmError``
    (a 500 the worker catches) and the VLM pass is skipped — never a render failure (invariant 7)."""
    global _available_cache
    if _available_cache is True:
        return True
    if is_apple_silicon():
        if _available_cache is None:
            _available_cache = _probe_mlx()
        return _available_cache
    # Remote server can come up at ANY time — re-probe when down (a refused connection fails
    # instantly), cache only success.
    if _probe_remote():
        _available_cache = True
        return True
    return False


def _probe_mlx() -> bool:
    """Apple path: mlx-vlm INSTALLED (by spec, not import — see below) AND the Qwen snapshot in
    the local HF cache. ``local_files_only`` never downloads on a probe, so a missing snapshot
    just ⇒ False (inert until ``make fetch-vlm``)."""
    import importlib.util

    # find_spec checks mlx_vlm is installed WITHOUT executing it: importing mlx_vlm here creates
    # its module-level GPU `generation_stream` (mlx_vlm/utils.py) on THIS thread, but generate()
    # runs on the dedicated _vlm_executor thread and that stream is thread-bound ("no Stream(gpu,
    # 1) in current thread"). So the first real import must happen inside _run_vlm_sync, never here.
    if importlib.util.find_spec("mlx_vlm") is None:
        return False
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(MODEL_ID, local_files_only=True)
        return True
    except Exception:  # noqa: BLE001 — snapshot missing ⇒ unavailable (until make fetch-vlm)
        return False


def _probe_remote() -> bool:
    """Non-Apple path: is the OpenAI-compatible server up and does it hold the configured model?
    A clear log tells the user exactly what to do when it isn't — the render proceeds either way."""
    try:
        import httpx
    except Exception:  # noqa: BLE001 — httpx is a runtime dep; if somehow absent, degrade
        return False
    try:
        resp = httpx.get(
            f"{_REMOTE_BASE_URL}/models",
            timeout=_REMOTE_PROBE_TIMEOUT,
            headers={"Authorization": f"Bearer {_REMOTE_API_KEY}"},
        )
        resp.raise_for_status()
        ids = {str(m.get("id", "")) for m in resp.json().get("data", [])}
    except Exception as exc:  # noqa: BLE001 — server not up yet ⇒ skip the gate for now
        _log.info(
            "VLM: no OpenAI-compatible server at %s (%s) — start Ollama / LM Studio to enable the "
            "VLM gate; the render proceeds without it meanwhile",
            _REMOTE_BASE_URL,
            exc.__class__.__name__,
        )
        return False
    if _REMOTE_MODEL in ids:
        return True
    _log.warning(
        "VLM: server at %s is up but is missing model %r (has %s) — run `ollama pull %s`",
        _REMOTE_BASE_URL,
        _REMOTE_MODEL,
        sorted(ids)[:8],
        _REMOTE_MODEL,
    )
    return False


def _load() -> None:
    """Load the Qwen2.5-VL model + processor + config into the module globals. Called by
    the sync worker only when nothing is resident — the weights are evicted after every
    batch, so a fresh run reloads them."""
    global _model, _processor, _config
    from mlx_vlm import load
    from mlx_vlm.utils import load_config

    model, processor = load(MODEL_ID)
    _model = model
    _processor = processor
    _config = load_config(MODEL_ID)


def _evict() -> None:
    """Release the ~2.2 GB Qwen weights after a batch (load-on-demand + evict, doc 25
    §6). Dropping the module refs frees Python's hold; MLX keeps a buffer cache too, so
    clear it — guarded, since an older mlx may lack ``clear_cache`` and it must never be
    fatal."""
    global _model, _processor, _config
    _model = None
    _processor = None
    _config = None
    gc.collect()
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:  # noqa: BLE001 — buffer-cache clear is best-effort, never fatal
        pass


def _checklist_prompt(description: str, era: str) -> str:
    """Build the strict-JSON checklist question for one candidate image (doc 25 §5-D).
    Pure — no model state — so it is unit-tested without the weights present."""
    era_clause = (
        "always answer true — this beat is era-agnostic (nature / space / abstract)"
        if era == "timeless"
        else (
            f'does the scene look {era} in its period, styling, technology, and dress? '
            "if you genuinely cannot tell, answer true"
        )
    )
    return (
        "You verify whether an image fits one beat of a video. Study the image and "
        "answer four yes/no questions, then reply with ONLY a JSON object — no prose, "
        "no markdown — in exactly this shape:\n"
        '{"subject_present": true, "shot_type_matches": true, "era_matches": true, '
        '"contradicting_text": false}\n\n'
        f'- subject_present: does the image clearly depict "{description}"?\n'
        "- shot_type_matches: is it a well-framed shot of that subject (NOT a tiny, "
        "incidental, cropped, or background appearance)?\n"
        f"- era_matches: {era_clause}.\n"
        "- contradicting_text: is there burned-in text, a caption, or a watermark that "
        "contradicts the subject or era? (true means such text IS present.)\n\n"
        "Reply with ONLY the JSON object."
    )


def _coerce_bool(value: object, default: bool) -> bool:
    """Coerce a parsed JSON value to bool. Clean Qwen output is a real bool; tolerate a
    stringified / numeric answer, and fall back to ``default`` for anything else (a
    missing or unrecognised value must never flip a verdict)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        token = value.strip().lower()
        if token in ("true", "yes", "y", "1"):
            return True
        if token in ("false", "no", "n", "0"):
            return False
    return default


def _parse_checklist(text: str) -> dict | None:
    """Extract the first ``{...}`` object from the model's reply and coerce the four
    keys to bools. Returns ``None`` when no JSON object is present (caller drops the
    candidate to ``failed``). Conservative defaults for a missing key: subject_present
    and era_matches default True so a parse gap can never veto; contradicting_text
    defaults False; shot_type_matches defaults True (a gap must not penalize). Pure —
    unit-tested without the weights present."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match is None:
        return None
    try:
        raw = json.loads(match.group(0))
    except (ValueError, TypeError):
        return None
    if not isinstance(raw, dict):
        return None
    return {
        "subject_present": _coerce_bool(raw.get("subject_present"), True),
        "shot_type_matches": _coerce_bool(raw.get("shot_type_matches"), True),
        "era_matches": _coerce_bool(raw.get("era_matches"), True),
        "contradicting_text": _coerce_bool(raw.get("contradicting_text"), False),
    }


def _run_vlm_sync(items: list[dict]) -> tuple[list[dict], list[str]]:
    """Load (once), run the checklist over every item, then EVICT the weights. A single
    item's exception or unparseable output is reported in ``failed`` and never fatal —
    but a failure to LOAD propagates (the worker catches it and skips the gate)."""
    import contextlib
    import io

    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template
    from PIL import Image

    from app.models import resize_to_max_side

    results: list[dict] = []
    failed: list[str] = []
    try:
        if _model is None or _processor is None or _config is None:
            _load()
        assert _model is not None and _processor is not None and _config is not None
        for item in items:
            path = str(item.get("path", ""))
            tmp_path: str | None = None
            try:
                # Downscale big images before generate (see _MAX_SIDE). A resized copy goes to
                # a temp file so we hand generate a path; small images use the original file.
                with Image.open(path) as raw:
                    rgb = raw.convert("RGB")
                capped = resize_to_max_side(rgb, _MAX_SIDE)
                gen_path = path
                if capped is not rgb:
                    tmp_path = f"{path}.vlm{_MAX_SIDE}.jpg"
                    capped.save(tmp_path, "JPEG", quality=90)
                    gen_path = tmp_path

                question = _checklist_prompt(
                    str(item.get("description", "")), str(item.get("era", "timeless"))
                )
                prompt = apply_chat_template(_processor, _config, question, num_images=1)
                # mlx-vlm 0.1.27 prints a benign "Failed to process inputs … return_tensors='pt'"
                # warning to stderr on EVERY call (a transformers-5.x processor quirk) — it always
                # falls back to pt and works. Swallow that stderr spam; real errors still raise.
                with contextlib.redirect_stderr(io.StringIO()):
                    out = generate(
                        _model,
                        _processor,
                        prompt,
                        image=gen_path,
                        max_tokens=_MAX_TOKENS,
                        verbose=False,
                    )
                # mlx-vlm 0.1.x returns (text, metadata); older/newer returns bare text.
                text = out[0] if isinstance(out, tuple) else out
                parsed = _parse_checklist(str(text))
                if parsed is None:
                    _log.warning("VLM returned no parseable JSON for %s: %r", path, str(text)[:200])
                    failed.append(path)  # no JSON → no verdict, drop from the batch
                    continue
                results.append(
                    {
                        "path": path,  # always the ORIGINAL path the worker sent, never the temp
                        "subjectPresent": parsed["subject_present"],
                        "shotTypeMatches": parsed["shot_type_matches"],
                        "eraMatches": parsed["era_matches"],
                        "contradictingText": parsed["contradicting_text"],
                    }
                )
            except Exception:  # noqa: BLE001 — one bad image never sinks the batch
                # Log (never silently swallow): a persistent failure here is how the whole
                # gate silently no-ops, so it must be diagnosable in the sidecar logs.
                _log.warning("VLM checklist failed for %s", path, exc_info=True)
                failed.append(path)
            finally:
                if tmp_path is not None:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
    finally:
        _evict()  # always free the ~2.2 GB, even if load / a later item threw
    return results, failed


def _encode_image_data_uri(path: str) -> str:
    """Load → RGB → downscale to _MAX_SIDE → JPEG-base64 into a data URI for the OpenAI-style
    ``image_url`` field. Mirrors the MLX path's resize so both backends see the same pixels and
    neither blows up a server on a full-res screenshot."""
    import base64
    import io

    from PIL import Image

    from app.models import resize_to_max_side

    with Image.open(path) as raw:
        capped = resize_to_max_side(raw.convert("RGB"), _MAX_SIDE)
    buf = io.BytesIO()
    capped.save(buf, "JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _remote_verdict(path: str, content: str) -> dict | None:
    """Parse one server reply into the worker's verdict shape (identical to the MLX path).
    Returns None when the reply carries no JSON object (caller drops it to ``failed``)."""
    parsed = _parse_checklist(content)
    if parsed is None:
        _log.warning("VLM (remote) returned no parseable JSON for %s: %r", path, content[:200])
        return None
    return {
        "path": path,  # always the ORIGINAL path the worker sent
        "subjectPresent": parsed["subject_present"],
        "shotTypeMatches": parsed["shot_type_matches"],
        "eraMatches": parsed["era_matches"],
        "contradictingText": parsed["contradicting_text"],
    }


async def _run_vlm_remote(items: list[dict]) -> tuple[list[dict], list[str]]:
    """Windows/Linux path: ask an OpenAI-compatible server (Ollama / LM Studio) the SAME checklist
    the MLX path asks, one candidate at a time (the batch is tiny — top-k). ``response_format`` asks
    for JSON, and ``_parse_checklist`` still salvages a JSON object from prose if the server ignores
    it. A per-item failure lands in ``failed`` and never sinks the batch (mirrors the MLX path)."""
    import httpx

    results: list[dict] = []
    failed: list[str] = []
    async with httpx.AsyncClient(
        base_url=_REMOTE_BASE_URL,
        timeout=_REMOTE_TIMEOUT,
        headers={"Authorization": f"Bearer {_REMOTE_API_KEY}"},
    ) as client:
        for item in items:
            path = str(item.get("path", ""))
            try:
                question = _checklist_prompt(
                    str(item.get("description", "")), str(item.get("era", "timeless"))
                )
                payload = {
                    "model": _REMOTE_MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": question},
                                {
                                    "type": "image_url",
                                    "image_url": {"url": _encode_image_data_uri(path)},
                                },
                            ],
                        }
                    ],
                    "temperature": 0,
                    "max_tokens": _MAX_TOKENS,
                    "response_format": {"type": "json_object"},
                }
                resp = await client.post("/chat/completions", json=payload)
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"]
                verdict = _remote_verdict(path, str(content))
                if verdict is None:
                    failed.append(path)
                else:
                    results.append(verdict)
            except Exception:  # noqa: BLE001 — one bad item never sinks the batch
                _log.warning("VLM (remote) checklist failed for %s", path, exc_info=True)
                failed.append(path)
    return results, failed


def _unavailable_message() -> str:
    """Platform-specific ``E_VLM_UNAVAILABLE`` guidance so each OS tells the user the RIGHT fix."""
    if is_apple_silicon():
        return (
            "E_VLM_UNAVAILABLE: Qwen2.5-VL not installed — cd services/ml && uv sync && "
            "make fetch-vlm"
        )
    return (
        f"E_VLM_UNAVAILABLE: no VLM server at {_REMOTE_BASE_URL} serving {_REMOTE_MODEL!r} — "
        f"install Ollama and run `ollama pull {_REMOTE_MODEL}` (or set VLM_BASE_URL to your "
        "LM Studio / OpenAI-compatible server)"
    )


async def run_vlm(items: list[dict]) -> tuple[list[dict], list[str]]:
    """Run the VLM checklist over ``items`` (each ``{path, description, era}``), returning
    ``(results, failed)``. Availability is probed first — an unready backend is a 500 the worker
    catches, not work. Dispatches by platform: Apple Silicon runs mlx-vlm on the dedicated,
    thread-pinned executor (serialised so two ~2.2 GB loads never coexist); elsewhere it calls the
    OpenAI-compatible server over async HTTP (no thread pinning needed)."""
    if not available():
        raise VlmError(_unavailable_message())
    if not items:
        return [], []
    if is_apple_silicon():
        # NOT asyncio.to_thread (shared pool — torch-MPS contaminates it, see _vlm_executor).
        async with _infer_lock:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(_vlm_executor, _run_vlm_sync, items)
    return await _run_vlm_remote(items)
