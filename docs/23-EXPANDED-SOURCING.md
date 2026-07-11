# 23 — Expanded Sourcing & Clip Intelligence

Extends doc 08 (search), doc 09 (matching), doc 12 (timeline), doc 13 (composition). Goal: source
media that is **exactly right for the script** and **strike-safe**, and cut it so the video never
feels boring — while staying free and lightweight. Owner directive 2026-07-11.

## 1. The two-class insight

Pexels + Pixabay are **stock B-roll**: modern, generic, uniform license, no per-item checks. The new
sources are **archives**: specific / named / historical / scientific content, but **per-item
licensing** and **variable quality**. The engine must treat them differently — route by domain,
verify per item, and check quality — or it produces mismatched, boring results.

## 2. Source set (universal, copyright-free)

Selected for the broadest coverage at zero strike risk. Domain-specialist archives (Europeana, LoC,
NOAA, USGS, ESA) are follow-ons, added the same way once the framework proves out.

| Source | Media | License | Best for | Auth |
|---|---|---|---|---|
| Pexels *(have)* | video + photo | Pexels License (commercial, no attrib) | modern generic B-roll | key |
| Pixabay *(have)* | video + photo | Pixabay License | modern generic B-roll | key |
| **Openverse** | image | CC/PD, **filter to cc0,pdm,by** | universal CC image reach (aggregator) | none (key = higher limits) |
| **Wikimedia Commons** | image (+ some AV) | per-file PD/CC0/BY/BY-SA | **named** people/places/events, science, history | none (MediaWiki API) |
| **Internet Archive** | **video**, audio, image | per-item (filter to PD/CC) | public-domain **video**, historical film | none |
| **NASA** | image + video | mostly public domain | space, Earth, science | none |
| **Smithsonian Open Access** | image | **CC0** | museum objects, art, nature, history | key (free) |

Video sources for clip intelligence (§7): Pexels, Pixabay, **Internet Archive**, **NASA**. Image
sources feed Ken Burns: Openverse, Wikimedia, Smithsonian, NASA, Pexels/Pixabay photos.

## 3. License policy (no-strike)

A candidate is admissible only if its normalized license is in the **allow set**, else it is dropped
before it can be chosen (never rendered, never a swap option):

- **Allow:** Public Domain / `pdm` / US-gov PD, `CC0`, `CC BY` *(attribution auto-added to
  `credits.txt`)*.
- **Reject:** `CC BY-SA` (share-alike would infect the output license), `*-NC` (non-commercial),
  `*-ND` (**we trim/pan/segment = a derivative → ND is a violation**), all-rights-reserved, and
  **unknown / unstated** (a missing license is a reject, not a maybe).

`packages/core` owns a pure `classifyLicense(raw: string | url) → { allowed, spdx, requiresAttribution }`
so every provider and the credits builder agree. Policy is a constant, not per-provider magic.

> Content-ID reality: PD/CC0/CC-BY from reputable archives minimizes false claims but can't make them
> impossible (someone else may have wrongly claimed PD footage). We choose reputable sources and
> record provenance; that is the honest ceiling of "no strike."

## 4. Provider framework changes

- `ProviderId` (core) extends to the union above; `MediaKind` unchanged (`video | image`).
- `RawCandidate.license` becomes **load-bearing** — every provider must set a real per-item license;
  the search stage runs the §3 gate right after fetch, before dedupe/scoring.
- New per-provider capability metadata: `{ media: ('video'|'image')[], domains: Domain[], attribution:
  'none'|'required' }`. Drives routing (§5) and credits.
- Each source is a small module implementing `MediaProvider`, registered in `SearchClient`, behind
  the existing `QuotaGuard` (add budgets to `QUOTA_BUDGETS`) + 24 h `SearchCache`. No hotlinking —
  archives download to `asset_cache` like everything else (doc 08).

## 5. Domain router (accuracy)

`analyze` already emits per-beat `entities` (people/places/objects) + `visualDescription`. Add a
cheap **domain tag** per beat (`space · earth/weather · history · science · nature · people · urban ·
art · abstract`) from the LLM (one enum field) with a keyword-fallback. The search stage then fans
out to the **2–3 providers whose `domains` match** — not all sources:

- *"Apollo 11 / Neil Armstrong"* → NASA + Internet Archive + Wikimedia
- *"a busy city morning"* → Pexels + Pixabay
- *"Renaissance fresco"* → Smithsonian + Openverse + Wikimedia
- *"a hurricane forms"* → NASA + Internet Archive (+ NOAA later)
- named person/place → Wikimedia/Smithsonian with an **exact-match** query + identity verification (§6)

Generic beats still hit Pexels/Pixabay; archives only fire where they add signal. This keeps quota
and latency down while lifting relevance.

## 6. Media cross-check (verify what we got)

Applied to the **top-K** candidates only (cheap, cached per asset by checksum):

1. **Video subject-presence:** sample ~3–5 frames across the clip, SigLIP-score each vs the beat.
   Reject clips whose frames don't depict the subject; keep the best-matching **window** (→ §7).
2. **Quality gate:** drop low-res, letterboxed, watermarked, or visually cluttered assets (resolution
   + sharpness + aspect-fit heuristics; no new model).
3. **Named-subject verification:** when a beat names a specific person/landmark, require a stronger
   archive match; a generic stand-in must not pass as the named subject.

Archives (variable quality) benefit most; stock B-roll usually passes trivially.

## 7. Clip & frame intelligence (never boring)

`timeline.json` **already carries `inPointSec`** — the renderer can start a clip anywhere. What's new
is choosing it, and using more than one window per beat:

- **Shot detection** via ffmpeg scene-cut (existing dependency, no model) splits a source into shots.
- **Interest scoring** per shot: motion (frame diff) + sharpness + SigLIP relevance → pick the best
  in-point (`inPointSec`), not the first N seconds.
- **Multi-segment per beat** — a small timeline schema extension: a long or static beat gets **2 short
  windows** (a mini-montage) instead of one boring hold. Biggest anti-boring lever.
- **Variety/pacing pass:** avoid back-to-back similar shots; alternate wide/close, motion/still,
  video/photo; **saliency-aware Ken Burns** on stills (pan toward the subject, not arbitrary).

Contract change (doc 12): a beat's `media` becomes `media | media[]` (ordered sub-segments, each with
its own `inPointSec`/`durationSec` summing to the beat's narration length). Single-segment beats are
unchanged, so it's backward compatible.

## 8. Free & lightweight discipline

- Every source is free (public / CC / PD). No paid tier, ever, in this scope.
- Bounded compute: analyze only **top-K** candidates, sample **≤ 5 frames** per video, reuse the
  existing SigLIP sidecar (batch frames), no new heavy models.
- **Analysis cache** (new): per-asset shots / best-window / frame-embeds keyed by checksum, so
  re-renders and swaps are free. Extends the existing SearchCache + asset_cache discipline.
- **Degrade, never die:** any analysis failure/timeout falls back to today's behavior (`inPointSec=0`,
  single segment); the ladder still ends at a text card.

## 9. Contract changes (summary)

1. `ProviderId` union + per-provider capability metadata.
2. `RawCandidate.license` enforced via `classifyLicense` gate.
3. `beats` get a `domain` field (analyze); `QUOTA_BUDGETS` gains the new providers.
4. `timeline.json` beat `media` may be an ordered array of sub-segments (backward compatible).
5. New `asset_analysis` cache (shots, best-window, frame-embeds).

## 10. Phasing (one slice per session, like the roadmap)

- **23a — Framework + first universal source.** License model (`classifyLicense` + gate), provider
  capability metadata, **Openverse** (universal CC/PD images). Prove the pattern end-to-end.
- **23b — Video archives.** **Internet Archive** + **NASA** (public-domain video + images) — unlocks
  §7 on non-stock footage.
- **23c — Named-subject archives.** **Wikimedia Commons** + **Smithsonian** (CC0). Domain router (§5).
- **23d — Media cross-check.** Frame-sampling verification + quality gate (§6).
- **23e — Clip-segment selector.** Shot detection, best-window, multi-segment, variety pass (§7).
- **23f — Eval + tune.** Extend `eval:matching`, golden set, and a "variety/boring" rubric; measure
  the lift (precision@1, fallback %, relevance, variety) before/after.

Exit for the whole initiative: on the golden set, **higher relevance and lower text-card fallback than
Pexels+Pixabay alone**, visibly more varied cutting, and **every asset strike-safe** with correct
per-item attribution — at no new cost and within the existing time budget.
