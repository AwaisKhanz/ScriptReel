# 01 — Product Brief

## Vision

Paste a script, press Generate, get a finished video: relevant visuals cut to a natural voiceover, word-accurate subtitles, background music, smooth transitions — output that feels human-edited. Runs entirely on the owner's MacBook (M3 Pro) using free and open-source components. Zero marginal cost per video.

## Why this can beat existing tools (Pictory, Fliki, InVideo)

Their weakness is not AI understanding — it is naive keyword search against shallow stock libraries with no graceful degradation, producing mismatched B-roll. ScriptReel's differentiator is the **matching engine**: LLM-produced *visual descriptions* per beat, multi-angle query fan-out, CLIP-family semantic re-ranking of candidates, and an explicit fallback ladder (broaden → conceptual → mood → generated image → styled text card). A good abstract match always beats a wrong literal one.

## Target user (v1)

Single local user (the owner). Content creators are the eventual market; v1 is a production-quality internal tool and the foundation for a SaaS. No auth, no multi-tenancy — but the schema stays multi-user-ready (doc 05).

## v1 scope (locked)

- Script input up to **6,000 characters** (~5–6 min narration), plain text.
- **9 language variants** (en-US, en-GB, es, fr, hi, it, pt-BR, ja, zh) with **54 selectable voices** (Kokoro), voice preview, speed control.
- **3 aspect ratios** (16:9, 9:16, 1:1) and 2 quality presets (Draft 720p fast / Final 1080p).
- Media from **Pexels + Pixabay** (videos + photos), semantic ranking, local cache, auto-generated credits file.
- **Storyboard review** step (optional, on by default): swap any beat's media among top candidates or re-search a beat before rendering.
- Voiceover (Kokoro), word-synced subtitles (5 style presets incl. karaoke), background music (bundled CC0 library, mood-tagged, auto-ducked).
- Ken Burns motion on stills, crossfade/cut transitions, hardware-accelerated encode (VideoToolbox).
- Full progress UI with per-stage status; resumable pipeline; cheap re-render when only subtitles/music/quality change.
- Generative image fallback (FLUX.1-schnell, Apache 2.0) — **Phase 13**, behind a flag.

## Explicit non-goals (v1)

No cloud deployment, no auth/accounts, no payment, no talking-head avatars, no AI music generation, no drag-and-drop timeline editor (swap/re-search only), no 4K, no stock sound effects, no per-beat text overlays beyond subtitles/text cards, no video upload by user, no translation of scripts (script language in = narration language out). UI chrome is English; content is multilingual.

## Success criteria

1. A 90-second English educational script renders end-to-end, untouched, and an honest reviewer rates media relevance ≥ 4/5 average per beat (rubric in doc 21).
2. Warm end-to-end time for that script on M3 Pro ≤ 6 minutes (Draft) / ≤ 10 minutes (Final). Benchmarked in Phase 14.
3. The same project re-renders with a different subtitle style in < 90 seconds (compose-only path).
4. A Hindi and a Japanese golden script render with correct fonts, subtitles, and narration.
5. Two videos can be produced back-to-back without exhausting any free-tier quota (budget math in doc 22).

## Cost posture

v1 spends $0. The only account-gated dependencies are free API keys (Pexels, Pixabay, optional Gemini). Every AI capability has a fully-local path (Ollama, Kokoro, mlx-whisper, SigLIP, FLUX-schnell). Paid upgrades (ElevenLabs voices, paid LLM, cloud render) are deliberate future swaps at seams defined in doc 03 — never rewrites.
