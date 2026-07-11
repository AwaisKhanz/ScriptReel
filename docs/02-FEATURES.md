# 02 — Features & Controls

Every user-facing control, its options, default, and where it takes effect. Settings persist per-project in `projects.settings` (jsonb, zod-validated by `packages/core/src/settings.ts`). Changing a setting invalidates only the stages that consume it (doc 06 §Invalidation).

## 1. Script input

| Control | Spec |
|---|---|
| Script textarea | Plain text, 50–6,000 chars. Live counter: chars, words, estimated narration duration (words ÷ effective wpm, doc 10) and estimated beat count |
| Title | Optional; defaults to first 6 words of script |
| Language | Auto-detected during analysis; user may pre-select to skip detection. Options: en-US, en-GB, es, fr, hi, it, pt-BR, ja, zh |

## 2. Voice & narration

| Control | Options | Default |
|---|---|---|
| Voice | 54 Kokoro voices, grouped by language, each with ▶ preview (cached sample, doc 10) | `af_heart` (en), per-language defaults in doc 10 |
| Speed | 0.80–1.30, step 0.05 | 1.00 |
| Pause between beats | 0–600 ms silence inserted at beat boundaries | 150 ms |

## 3. Format & quality

| Control | Options | Default |
|---|---|---|
| Aspect ratio | 16:9 (1920×1080) · 9:16 (1080×1920) · 1:1 (1080×1080) | 16:9 |
| Quality preset | Draft (720p-equivalent, fast encode, watermark-free) · Final (1080p, VideoToolbox high bitrate) | Final |
| FPS | Fixed 30 (not user-exposed in v1) | 30 |

## 4. Visuals & pacing

| Control | Options | Default |
|---|---|---|
| Pacing | Fast (target beat 3–5 s) · Normal (5–8 s) · Slow (7–11 s) | Normal |
| Media preference | Videos only · Mixed (videos + photos w/ Ken Burns) · Photos allowed freely | Mixed |
| Transition style | Crossfade · Hard cut · Smart mix (cut within same shot type, fade across emotion/scene change) | Smart mix |
| Crossfade duration | 0.3–0.6 s | 0.4 s |
| Allow generated images | On/Off (visible only when Phase 13 shipped and model installed) | Off |
| Review before render | On → pipeline pauses at storyboard; Off → straight through | On |

## 5. Subtitles

| Control | Options | Default |
|---|---|---|
| Style preset | `clean` · `pop` (word-karaoke, bold center — 9:16 default) · `lowerthird` · `documentary` · `none` | `clean` (16:9), `pop` (9:16) |
| Position | Bottom · Middle · Top (per-preset sensible subset) | Preset default |
| Live preview | Style rendered on a sample frame in settings UI (doc 16) | — |

Presets are fully defined (fonts, colors, ASS params) in doc 17 §Subtitle presets and doc 11.

## 6. Music

| Control | Options | Default |
|---|---|---|
| Mood | None · Uplifting · Calm · Corporate · Emotional · Energetic · Tense · Auto (LLM picks from script emotion) | Auto |
| Track | Auto-pick from the bundled CC BY 4.0 library (Kevin MacLeod) by mood, or manual pick from library list, or **user upload** (mp3/wav ≤ 20 MB) | Auto |
| Music level | −24 to −10 dB relative to voice | −16 dB |
| Ducking | Fixed sidechain (doc 13); on whenever music present | On |

## 7. Storyboard review (the control surface)

Shown after SCORING when `reviewBeforeRender = on`. Per beat: chosen media thumbnail (hover/tap = motion preview via short proxy clip), beat text, duration, emotion tag, similarity score badge, and:

- **Swap** — drawer with the top 8 ranked alternates (thumbnails + provider + duration); one tap replaces.
- **Re-search** — edit the beat's visual description and/or add a custom query; re-runs search+score for that beat only (quota-budgeted, doc 08).
- **Force text card** — replaces media with a styled key-phrase card.
- **Approve all → Continue** — resumes pipeline.

No reordering, splitting or merging of beats in v1 (narration order is the script).

## 8. Output & post-render

- Player with generated video, duration, file size.
- **Download MP4** and **Reveal in Finder**.
- **credits.txt** auto-generated per render (every asset: provider, author, URL) — downloadable.
- **Re-render** panel: change subtitle style, music, quality, aspect → re-runs only invalidated stages (aspect change re-runs fetch+compose; subtitle/music/quality change re-runs compose only).
- Render history per project (doc 05 `renders`).

## 9. System screens

- Dashboard: project cards (status chip, thumbnail, duration), New Project.
- Progress screen: stage stepper with live per-stage progress, elapsed time, cancel, and log tail (doc 16).
- Settings (global): API keys status check, model download status, cache size + clear-cache, DATA_DIR path, quota meters (Pexels hourly/monthly, Pixabay per-minute — read from `provider_usage`).

## 10. Defaults philosophy

Every default must produce a good video with zero setting changes. Controls exist for intent, not for rescuing bad defaults.
