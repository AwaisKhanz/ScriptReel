# 22 — Risks, Limits & Licenses

Everything here was verified on **2026-07-07** against live provider/model documentation. Terms move. Re-verify before any public launch, and treat this file as the place where that re-verification is recorded.

## Quota math (the binding constraint)

A 3-minute script ≈ 470–500 words ≈ **44 beats** (doc 07 pacing).

| Preference | Requests/beat | Pexels/video | Pixabay/video |
|---|---|---|---|
| Videos only | 2 | 44 | 44 |
| **Mixed (default)** | 3 | 44 | 88 |
| Photos allowed | 4 | 88 | 88 |

Escalation (ladder rungs 1–3) fires only on beats below `τ_lo` — budget **1 extra request per weak beat, max 20% of beats** → ≈ +9. Storyboard re-search: ≤ 4 requests per beat, gated below reserve.

**Budgets** (`packages/core/src/constants.ts`, enforced by `QuotaGuard`):

```
PEXELS_HOUR_BUDGET   = 190   // of 200; 10 held back
PEXELS_MONTH_BUDGET  = 19_000 // of 20,000
PIXABAY_MINUTE_BUDGET = 90    // of 100
RESEARCH_RESERVE     = 30    // requests kept free for storyboard re-search
```

Consequences to accept: **~3 cold 3-minute videos per hour** on Pexels' free tier (mixed preference). Warm re-runs and re-renders are free (24 h cache). If the hour budget hits zero mid-run, the ladder degrades to conceptual/text-card rather than stalling — the run always finishes. Pexels offers a free unlimited tier on application with attribution proof; do that before treating this as a product.

## License obligations (what we must actually do)

| Thing | License | Obligation | Where satisfied |
|---|---|---|---|
| Pexels media | Pexels License | Attribution appreciated, not required; API terms require showing the photographer + a link where results are displayed, and caching rather than hammering | Candidate drawer chips; `credits.txt`; SearchCache |
| Pixabay media | Content License | Show source when displaying results; **do not hotlink**; cache API responses 24 h; no redistribution of assets as-is | Drawer chips; assets downloaded to `cache/assets`; SearchCache |
| Bundled music | CC0 (FreePD) | None. We credit anyway | `credits.txt`, `music_tracks.credit` |
| Kokoro-82M | Apache-2.0 | Notice retained | `THIRD_PARTY_NOTICES.md` |
| SigLIP 2 | Apache-2.0 | Notice | same |
| Whisper / MLX ports | MIT | Notice | same |
| FLUX.1-schnell | Apache-2.0 | Notice. (Only Apache-licensed generator of this quality — SDXL-Turbo is non-commercial and is rejected) | same |
| FFmpeg | LGPL/GPL depending on build | We invoke it as a **separate process**, never link it. Brew's build includes GPL components (`--enable-gpl`) — that's fine for a CLI child process; do not statically link or ship a modified binary without reading the terms | doc 13 |
| Fonts (Inter, JetBrains Mono, Source Serif 4, Noto) | OFL | Retain license files, don't sell the fonts | `assets/fonts/OFL.txt` |
| Gemini free tier | Google API ToS | **Free-tier inputs may be used to improve Google's products.** No confidential scripts | doc 04; `LLM_PROVIDER=ollama` is the private path |

`credits.txt` per render lists every asset: `provider · author · page URL · license`, plus music and a "Narration synthesized with Kokoro-82M" line. It ships next to the MP4 and is downloadable from the result screen.

**Not legal advice.** Stock-media terms constrain *how* assets may be used (e.g. neither Pexels nor Pixabay permit redistributing assets standalone, or implying endorsement by depicted people). Read both licenses before commercial release, and before any feature that exports raw source clips rather than composed videos.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation (already in the design) |
|---|---|---|---|
| **Free stock libraries lack the shot** | Certain | The product's core failure mode | 5-rung ladder (doc 09); text cards always succeed; G6 exists to keep us honest; fallback rate is a tracked metric (< 20%, doc 21) |
| Pexels hourly limit during a long script | Likely | Run stalls | Budgets + reserve; ladder degrades instead of blocking; cache makes iteration free |
| Gemini free-tier limits or model id changes | Likely | analyze fails | `ScriptAnalyzer` interface; automatic Ollama fallback; model id in `.env`, not code |
| Provider changes response shape | Occasional | search breaks | Zod parse at the boundary + recorded fixtures; thumbnail extraction has an ffmpeg fallback path |
| SigLIP thresholds don't transfer across models | Certain if model swapped | Silent quality collapse | `[CALIBRATE]` markers; `eval:matching` is a gate, not a suggestion (doc 21) |
| Whisper misaligns (accents, CJK, numbers) | Occasional | Subtitle drift | We *align* known text, not transcribe; confidence check → proportional fallback; drift gate p95 ≤ 120 ms |
| VideoToolbox quality at low bitrate | Occasional | Soft output | Bitrate set high (10–12 Mbps); `FORCE_X264=1` archival A/B documented |
| `zoompan` jitter on stills | Certain if naive | Amateur look | Pre-scale 1.5–2× before zoom (doc 13); visual check is a Phase 8 exit criterion |
| Disk fills (models 7 GB + asset cache) | Likely over time | Hard failure mid-render | `E_DISK_FULL` pre-checks before fetch/compose; LRU eviction by `asset_cache.last_used_at`; cache size + clear in settings |
| FLUX OOM on 18 GB while Chrome runs | Likely | Sidecar dies | Free-memory guard → `E_GEN_MEM` → skip rung 4; idle unload after 5 min |
| Unofficial/unstable deps creep in | Possible | Product risk | Rejected list in doc 04 is binding (no Edge TTS, no Remotion, no SDXL-Turbo). New dep = new row with license |
| Docs and code drift | Certain without care | Everything | Constants live in `packages/core/src/constants.ts`; docs quote them; the settings→invalidation table is encoded as a test (doc 21) |

## Known limits of v1 (say these out loud in the README)

Single user, single machine, no auth, no cloud. One render at a time. ≤ 6,000 characters of script. 30 fps, 1080p max. Nine narration languages, English-quality is meaningfully better than the rest. English search queries only (providers are English-indexed) — this is a feature, not a bug, but it means culturally-specific visuals for non-English scripts will underperform. No timeline editor: you can swap a beat's media, not its order or duration. Beat durations are dictated by narration and cannot be stretched. The visuals are stock; nothing here makes a shot that doesn't exist.
