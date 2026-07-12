# ScriptReel ML sidecar — auxiliary setup targets (doc 19).
.PHONY: sync setup-ja fetch-models fetch-identity

sync:
	uv sync

# Japanese narration needs unidic (~1 GB) and misaki[ja] — run only if you narrate ja.
setup-ja:
	uv add "misaki[ja]"
	uv run python -m unidic download

# Download model weights (doc 19 §5). Pass FLUX=0 to skip the 6.5 GB FLUX model.
fetch-models:
	uv run python -m scripts.fetch_models $(if $(filter 0,$(FLUX)),--no-flux,)

# Reference-identity cascade models (doc 25 §5-C): DINOv2 (~88 MB) + InsightFace
# buffalo_l (~300 MB, non-commercial license — doc 25 §6). Optional; the identity
# gate stays inert until these are present.
fetch-identity:
	uv run python -m scripts.fetch_models --identity
