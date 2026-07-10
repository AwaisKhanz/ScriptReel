# ScriptReel ML sidecar — auxiliary setup targets (doc 19).
.PHONY: sync setup-ja fetch-models

sync:
	uv sync

# Japanese narration needs unidic (~1 GB) and misaki[ja] — run only if you narrate ja.
setup-ja:
	uv add "misaki[ja]"
	uv run python -m unidic download

# Download model weights (doc 19 §5). Pass FLUX=0 to skip the 6.5 GB FLUX model.
fetch-models:
	uv run python -m scripts.fetch_models $(if $(filter 0,$(FLUX)),--no-flux,)
