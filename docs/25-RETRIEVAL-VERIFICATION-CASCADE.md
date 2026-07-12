# 25 — Retrieval & Verification Cascade

Extends doc 07 (analysis), doc 08 (search), doc 09 (matching), doc 23 (expanded sourcing), doc 24
(entity intelligence). Goal: make visual selection correct for **any** script — historical, modern,
scientific, natural, artistic, or about a specific person / place — by (1) tagging each beat's
**era**, (2) **expanding knowledge** from Wikidata + Wikipedia before searching, (3) **federating**
many domain-specific free archives, and (4) putting every candidate through a **verification cascade**
(deterministic → SigLIP → reference identity → VLM) so the asset that survives genuinely depicts the
beat, in the right era, with no contradicting text. Owner directive 2026-07-12.

> **Directive change — reverses "no local models".** doc 24 was OpenAI-only and FLUX / Phase 13 were
> deferred. This doc adds **five local models** — OCR (Tesseract), InsightFace, DINOv2,
> Qwen2.5-VL-3B (MLX), SDXL — run in the Python sidecar with lazy-load / evict. **GPT stays the only
> cloud call (analyze).** See §6 for the model inventory, resource strategy, and licensing caveats.

## 1. The problem this fixes (why it must "work for all")

The keyword / SigLIP path picks a *plausible* image, not a *correct* one. For a general tool that is
not enough:

- **Era mismatch** — a modern photo standing in for a 1600s event (or the reverse).
- **Lookalikes** — a random man passing for a named person; the wrong building for a named landmark.
- **Watermarks / burned-in text** — a stock clip with a logo, or on-screen text that contradicts the
  narration.
- **Domain gaps** — no good source for a specific bird, the ocean floor, a museum painting, a NASA
  mission, a historical event.

The cascade + era + knowledge-expansion + many archives close each gap. **Degrade-never-die still
holds** — the ladder ends at a generated image (non-entity beats) or a text card.

## 2. Phase 1 — the `era` field (rule 12)

One field added to the analyze output. `BeatSchema` (doc 07 / doc 24) gains:

```ts
era: z.enum(['modern', 'historical', 'timeless']).default('timeless')
```

- **modern** — contemporary / present-day subjects (roughly post-1970).
- **historical** — pre-modern, or a specific past period / event.
- **timeless** — nature, space, abstract, or anything era-agnostic.

Prompt **rule 12**: the LLM sets `era` from the sentence's subject and any dates. Era becomes a
**hard signal** in verification (§5 D) and a **routing hint** in retrieval (historical → Internet
Archive / LoC / Europeana; modern → Flickr / stock). Each entity can also confirm its own era from
Wikidata dates (§3), cross-checked against the beat's era. Added to the strict OpenAI JSON schema +
the post-pass (a merged beat keeps the dominant era; a split beat inherits it).

## 3. Phase 2a — Knowledge expansion (pure code, before searching)

Deepen what we know about each *visualizable* entity **before** the query fan-out. No new models;
new API calls behind SearchCache + QuotaGuard, cached hard.

- **Wikidata deep-fetch** (extends the doc 24 resolver): from the P31-verified Q-id, read the image
  properties **P18 / P41 / P154 / P242**, plus **aliases** (alternate labels), **related entities**
  (notable claims — capital, part-of, creator, operator…), and **dates** — **P571** inception,
  **P569 / P570** birth / death, **P580 / P582** start / end → **confirm / derive the entity's era**
  and cross-check it against the beat's era.
- **Wikipedia REST summary** (`/page/summary/{title}`) → parse the lead into **2–3 extra concrete
  English visual query terms**, folded into the beat's search terms so the pool isn't limited to the
  LLM's first guesses.

Cache key: `entity → { images, aliases, relatedEntities, dates, era, extraTerms }`.

## 4. Phase 2b — Routed federated search (existing routing, new sources)

Every source is a `MediaProvider` behind the **existing SearchCache + QuotaGuard + no-strike license
gate** (doc 23 §3–4), with a `ProviderId`, quota windows, declarative credentials (keys in Settings),
and domain / category / era routing (doc 23 §5 / doc 24 §5). The router fans a beat out only to the
2–3 sources its domain + era warrant — never all of them.

| Source | Media | Key | License focus (must gate) | Routed for |
|---|---|---|---|---|
| Internet Archive | **video** | none | PD/CC — filter `licenseurl` | history, events, archival film |
| Flickr (CC) | image | key | CC-BY / CC0 / PD subset only | modern, everyday, worldwide |
| Europeana | image | free key | per-item (gate) | history, art, culture |
| Smithsonian OA | image | data.gov key | CC0 subset | art, history, objects, nature |
| Met Museum | image | none | CC0 | art, artifacts |
| Rijksmuseum | image | free key | public domain | art (esp. European) |
| Library of Congress | image | none\* | per-item (gate) | history, US, photographs |
| iNaturalist / GBIF | image | none | CC subset (gate) | nature, animals, plants |
| NOAA | image | none | US-gov public domain | ocean, weather, climate |
| USGS | image | none | US-gov public domain | geology, terrain, maps |
| ESA / ESA-Hubble | image | none | **Hubble/ESO CC-BY ✓ · ESA main CC-BY-SA ✗** | space (Hubble/ESO only) |

\* LoC is keyless but Cloudflare-gates automated traffic (doc 24 research) → low QPS + retries + a
real `User-Agent`; treat it as the flakiest source.

**Licensing caveat (owner policy):** the no-strike gate stays **PD / CC0 / CC-BY** (reject
BY-SA / NC / ND / unknown). So Flickr / iNat / Commons must filter to the allowed CC subset, and
**ESA main content (CC-BY-SA IGO) is rejected** — only ESA-Hubble / ESO (CC-BY) is usable.

**Multi-frame video candidates:** a video candidate is represented by **3 frames at 10 % / 50 % /
90 %** of its duration, not one thumbnail — so scoring and verification judge the whole clip, not one
lucky still. Changes thumbnailing (search), candidate storage, and every downstream step that embeds
a "thumb" (it now embeds/serves the best of the 3, or all 3).

## 5. Phase 4 — the Score → Verify cascade

Replaces the single GPT-vision fit-check (doc 24 §7) with a staged **local** cascade: cheap gates
first, expensive models only on the shortlist, adaptive skips to stay fast.

- **A · Deterministic gate** — existing license / orientation / dedupe, **plus an OCR gate**
  (Tesseract): a **watermark penalty** (a visible logo / text overlay lowers the score) and a
  **text-contradiction veto** (burned-in text that contradicts the beat or era → reject outright).
- **B · SigLIP-2 rank → top-5** — the existing embedding rank produces the shortlist. One model, no
  ensemble.
- **C · Reference identity — conditional on entity type** (only when a reference exists):
  - **person →** InsightFace face-embedding cosine vs the Wikidata **P18 portrait**; must clear a
    threshold `[CALIBRATE]` to count as the real person.
  - **landmark / artwork →** **DINOv2** image↔image similarity vs the reference image.
- **D · VLM checklist** — **Qwen2.5-VL-3B (MLX)** on the **top-3**, strict JSON: *subject present? ·
  shot type matches? · era matches? · any contradicting on-screen text?* **Adaptive: skip when the
  beat has no entity AND the SigLIP margin is strong** — a clear generic win needs no VLM call.
- **E · Decide** — any gate fails → drop to the next candidate; shortlist exhausted → the **ladder**:
  broaden → conceptual → mood → **SDXL generation (non-entity beats ONLY)** → **text card**. Entity
  beats **never** get a fabricated subject; abstract beats get a generated image before a bare card.

## 6. Local model inventory, resources, licensing

Run in the Python sidecar (alongside SigLIP-2 / Kokoro / Whisper). **Lazy-load + evict** — keep the
light ones resident, load the heavy ones per-request and release them, so the M3 Pro's unified memory
is never over-committed.

| Model | Job | ~Size | License | Strategy |
|---|---|---|---|---|
| Tesseract | OCR — watermark / text | 50 MB | Apache-2.0 ✓ | resident |
| InsightFace (buffalo_l) | face identity | 300 MB | **non-commercial research ⚠** | resident |
| DINOv2 (ViT-S/B) | image identity | 90–350 MB | Apache-2.0 ✓ | resident |
| Qwen2.5-VL-3B | VLM checklist | 3–6 GB | Apache-2.0 (Qwen) ✓ | load-on-demand |
| SDXL base | generative fallback | 6.5 GB | OpenRAIL++-M (commercial OK, use-restrictions) | load-on-demand (rare) |

⚠ **InsightFace caveat:** the pretrained buffalo models are licensed **for non-commercial research
only** — a real concern if this tool is monetized. Options: accept the caveat for now, or swap to a
permissively-licensed face model (Apache / MIT). Flagged so it is a conscious choice, not a surprise.

Model downloads total ~15–20 GB and need a setup step alongside the existing Kokoro / SigLIP / Whisper
setup (doc 19). Latency rises (identity + VLM per beat) — the §5 adaptive skips are what keep it
usable; measure and tune the skip thresholds.

## 7. Contract changes (summary)

1. `beats.era` (analyze) + per-entity era derived from Wikidata dates.
2. Entity-expansion cache (aliases, related entities, dates, extra query terms).
3. `ProviderId` union += the 11 new sources; per-source credentials + `PROVIDER_WINDOWS`.
4. Candidate model: a video carries **3 frames (10/50/90 %)** instead of one thumb.
5. Score stage: OCR gate → SigLIP top-5 → identity → VLM → cascade decision → SDXL ladder rung.
6. Sidecar: new endpoints — `/ocr`, `/face`, `/dino`, `/vlm`, `/generate`.
7. Phase 5+ (fetch / align / compose) and `timeline.json` are **unchanged**.

## 8. Free & lightweight discipline (still holds)

- Every source free / keyless or free-key; all cached + quota-guarded.
- Cascade bounded: gates cheap-first; identity only when a reference exists; VLM only top-3
  (adaptive-skipped); SDXL only as a rare non-entity fallback.
- Lazy-load / evict keeps memory in budget.
- **Degrade, never die** — the ladder still ends at a text card; any model failure falls through to
  the next rung (invariant 7).

## 9. Phasing (one step per session, with exit criteria)

- **Step 1 — Era + knowledge expansion (§2, §3).** `era` field + rule 12; Wikidata deep-fetch
  (images, aliases, related, dates → era) + Wikipedia summary → extra terms. *No new models.* Exit:
  every beat has an era; entities resolve richer props + alias / related terms.
- **Step 2 — Archives group A (§4).** Internet Archive, Flickr CC, Europeana, Smithsonian, Met,
  Rijks, LoC — behind the framework, keyed + routed. Exit: history / art beats pull from the right
  archives; routing covers group A.
- **Step 3 — Archives group B (§4).** iNat / GBIF, NOAA, USGS, ESA-Hubble. Exit: nature / ocean /
  geo / space beats route to their authoritative source.
- **Step 4 — Multi-frame video candidates (§4).** 3 frames at 10/50/90 % through search + storage +
  scoring. Exit: videos are judged on 3 frames.
- **Step 5 — Cascade A + B (§5).** OCR gate (watermark penalty + contradiction veto) + SigLIP top-5
  shortlist. *New model: Tesseract.* Exit: watermarked / contradicting clips filtered pre-cascade.
- **Step 6 — Cascade C (§5).** InsightFace (person) + DINOv2 (landmark / artwork) reference identity.
  *New models: InsightFace, DINOv2.* Exit: lookalikes / wrong landmarks can't pass.
- **Step 7 — Cascade D (§5).** Qwen2.5-VL-3B (MLX) checklist on top-3, adaptive skip. *New model:
  Qwen-VL.* Exit: the survivor is VLM-confirmed for subject + era + no contradicting text.
- **Step 8 — Cascade E (§5).** Full decision + ladder + SDXL generation (non-entity only) before the
  text card. *New model: SDXL.* Exit: abstract beats get a generated image; entity beats never get a
  fabricated subject.

Exit for the initiative: on a battery of scripts spanning eras and domains — a historical event, a
living person, a specific landmark, a bird, the ocean floor, a painting, a space mission, an abstract
idea — **every beat is supported by a correct, era-appropriate, verified, license-clean asset**, with
the cascade catching lookalikes, watermarks, and era mismatches — at no cloud cost beyond GPT analyze.
