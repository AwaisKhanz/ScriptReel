# ScriptReel — developer one-liners. See docs/19-SETUP-MACOS.md for prerequisites
# (Homebrew: ffmpeg-full, tesseract, node@22, pnpm, uv, espeak-ng, git-lfs; Python 3.12).
.PHONY: setup setup-ja models identity vlm gen-setup fetch-gen music sidecar dev check db test-sidecar clean-cache help
.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## One-liner: install JS + Python deps and create .env
	pnpm install
	cd services/ml && uv sync
	@[ -f .env ] || cp .env.example .env
	@echo ""
	@echo "Next: fill .env (OPENAI_API_KEY, PEXELS_API_KEY, PIXABAY_API_KEY, DATABASE_URL"
	@echo "      = Supabase Cloud session pooler), then:  make models && make identity && make music && make db"
	@echo "Then: pnpm dev   →   http://localhost:3000/settings  (all health cards green)"

models: ## Download ML models (~7 GB) into data/models (add --no-flux to skip FLUX)
	HF_HOME="$$PWD/data/models" uv run --directory services/ml python -m scripts.fetch_models

identity: ## Download reference-identity models (~400 MB: DINOv2 + InsightFace, doc 25 §6)
	HF_HOME="$$PWD/data/models" uv run --directory services/ml python -m scripts.fetch_models --identity

vlm: ## Download the VLM checklist model (~2.2 GB: Qwen2.5-VL-3B 4-bit, doc 25 §5-D)
	HF_HOME="$$PWD/data/models" uv run --directory services/ml python -m scripts.fetch_models --vlm

gen-setup: ## Install the isolated FLUX generation venv (services/gen, doc 25 §5-E)
	cd services/gen && uv sync

fetch-gen: ## Download FLUX.1-schnell 4-bit (~6.5 GB) for the generative fallback (doc 25 §5-E)
	HF_HOME="$$PWD/data/models" uv run --directory services/gen python -m gen --download

music: ## Download the 14 CC BY 4.0 music tracks into assets/music
	uv run --directory services/ml python ../../scripts/fetch_music.py || python scripts/fetch_music.py

setup-ja: ## Japanese narration extra: download unidic (~1 GB)
	cd services/ml && uv run python -m unidic download

db: ## Push migrations to Supabase Cloud and regenerate DB types
	pnpm db:migrate
	pnpm db:types

sidecar: ## Run the Python ML sidecar alone (:8484)
	pnpm sidecar

dev: ## Run web (:3000) + worker + sidecar via turbo
	pnpm dev

check: ## tsc + biome + vitest (must be green to finish a phase)
	pnpm check

test-sidecar: ## Run the sidecar's pytest golden tests
	cd services/ml && uv run pytest

clean-cache: ## Delete the on-disk media/thumb/search caches (frees disk)
	rm -rf data/cache/assets/* data/cache/thumbs/* data/cache/search/*
	@echo "cleared data/cache (assets, thumbs, search)"
