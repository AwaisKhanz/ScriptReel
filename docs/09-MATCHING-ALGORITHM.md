# 09 — Matching Algorithm (the core IP)

Selects the best asset per beat from scored candidates, degrading **intelligently** when the free libraries have nothing. Runs in the `score` stage; sidecar does embedding math, worker does everything else.

## Step 1 — Embed

- Text: `POST /embed/text` with each beat's `visualDescription` (batch all beats, one call).
- Images: `POST /embed/image` with all candidate `thumb_path`s (batched ≤ 64/call). SigLIP 2 base, L2-normalized vectors, MPS. Cache image embeddings on disk keyed by thumb checksum (`cache/thumbs/*.emb.f32`) — re-runs are free.

## Step 2 — Score every candidate

```
sim        = cosine(descEmbedding, thumbEmbedding)               // dominant term
quality    = 0.5·resFit + 0.3·durFit + 0.2·fpsFit                // each ∈ [0,1]
   resFit: 1 if candidate height ≥ target, else height/target
   durFit (videos): 1 if beatDur ≤ candDur ≤ 4·beatDur; linear falloff to 0.3 outside; images: 0.8 fixed
   fpsFit: 1 if ≥ 24 fps or image, else 0.5
orientFit  = 1 − min(1, |candAR − targetAR| / targetAR)          // post-crop tolerance
score      = 0.62·sim + 0.14·quality + 0.10·orientFit
           + 0.04·isVideo                                         // motion feels premium (mixed mode only)
           − 0.05·isIllustration
           − reusePenalty − dupPenalty − monotonyPenalty
```

Sequential penalties (computed during greedy selection, beat order):
- `reusePenalty = 0.15` if this exact asset already chosen in this project.
- `dupPenalty = 0.10` if `cosine(thumb, previousChosenThumb) > 0.92` (visual near-duplicate of the adjacent beat).
- `monotonyPenalty = 0.04` if same provider **author** as previous chosen beat.

> **[CALIBRATE] These are vetoes, not penalties — measured 2026-07-16, not yet changed.** In the
> base-score space they are subtracted from, the real rank-1 margin (top1−top2, 30 beats, `pnpm
> eval:matching --dump`) has **median 0.0053**, and the *entire* range of top-1 scores across all 30
> beats is **0.0775**. Against that:
>
> | penalty | value | vs median margin | exceeds the margin on |
> | --- | --- | --- | --- |
> | `monotonyPenalty` | 0.04 | **7.5×** | 30/30 beats |
> | `dupPenalty` | 0.10 | **18.7×** | 30/30 beats |
> | `reusePenalty` | 0.15 | **28×** | 30/30 beats |
>
> So whenever one fires it decides the beat outright, whatever the match quality — `reusePenalty`
> alone is ~2× the whole score range, which pushes any reused asset below `τ_lo = 0.314` and into the
> fallback ladder (real quota). They read as "prefer variety, all else equal"; they behave as "never,
> at any cost". Note also that reuse is banned **twice**: `ladder.ts` already hard-skips reused
> `assetKey`s, so the 0.15 buys nothing the ladder doesn't already enforce — it only forces the ladder.
>
> This is what the redesign's P7 ("editorial signals belong as a **tiebreak**, never as a summand")
> is really about, and it applies to these shipped penalties, not just to future editorial scoring.
> It also means the redesign's R3 cure is aimed wrong: §3.12's global assignment would optimally
> solve *this same objective*. The defect is the magnitudes, not the greediness.
>
> **Deliberately unchanged.** Picking the right values needs a label set that can adjudicate taste,
> and the model-judged fixture cannot: at n=50 `pnpm eval:kappa --score` measures κ(model, human) =
> **0.160** (the n=30 preliminary read 0.416 at reliability 1.000) — the labels are systematically
> *biased*, not merely noisy. Re-scaling a constant against a biased instrument is how the shipped
> `τ = 0.322` came to claim 90% precision and deliver 78.8%. The 80 human labels are now enough to
> re-fit τ (see step 3) but not to adjudicate these magnitudes, which need per-beat taste judgements
> the κ sample does not collect. Whether variety is a hard ban or a soft preference is also a product
> decision, not an eval result.

## Step 3 — Greedy selection with thresholds

Constants `[CALIBRATE in Phase 6]` against the golden set; SigLIP cosine ranges are model-specific, so calibrate empirically: score 30 hand-labeled (good/bad) beat–thumb pairs, set `τ_hi` at the 90%-precision point and `τ_lo` at 70%.

**Re-calibrated 2026-07-17** (`siglip2-base-patch16-224`, **218 HUMAN labels / 30 beats** — the whole fixture hand-judged, `pnpm eval:matching --human-only`): `τ_hi = 0.341` **@80%**, `τ_lo = 0.311` @70%, in **base-score space** (not raw cosine). ROC-AUC base 0.763 (raw sim 0.751), base rate 58.3% good. Scores compress near ~0.30 because the non-sim quality/orient terms are ≈constant for HD stock video, so the discriminating signal is the SigLIP cosine riding on that offset — re-fit both `packages/core/src/constants.ts` and this line whenever the model or the score formula changes.

> **τ_hi is @80% because @90% does not exist.** The base score never exceeds **81.7%** precision at *any* threshold (τ=0.350, 60 candidates clearing). That is a property of the score, not of the threshold — no re-fit produces a 90% tier. Every previous value in this row was fitted to a target the axis cannot reach and then reported as though it had been hit. `eval:matching` now prints the ceiling so it cannot recur silently.
>
> **Each earlier value failed instructively:**
> | value | fitted on | what it actually delivers on 218 human labels |
> |---|---|---|
> | `0.322` (07-11) | 30 pairs | reproduced *exactly* on its own subset — overfitting |
> | `0.360` (07-16) | 222 labels, 192 model-judged | 78.3% precision, only **23/218** candidates clear it |
> | `0.338` (07-17) | 80 human labels, claimed @90% | **76.9%** — retired within hours by 138 more labels |
> | `0.341` (now) | 218 human labels, @80% | 80%+, no sample ⇒ no sampling bias |
>
> `0.338` is the cautionary one: the 80 were 30 originals plus a κ round the sampler drew **25-good/25-bad by model label**, so the fit inherited a class balance chosen by the very instrument under test — and `precision(τ)` depends on prevalence. Small-n overfitting by a subtler route than `0.322`.
>
> **On the labels.** `pnpm eval:kappa --score` over **188 hand-labelled pairs** gives **κ = 0.361** (MODERATE). The earlier **κ = 0.160** was the 50-pair κ round alone, doubly stratified (by beat *and* by model label) — treat 0.361 as the estimate. The direction is stable at every n: the model calls **43 pairs bad that the human calls good** vs 18 the other way (2.4:1; 16:5 at n=50, 8:1 at n=30). Biased, not noisy — it demands literal subject presence where a human accepts thematic fit.
>
> **Direction is the point.** A mislabelled-bad pair is a phantom false-positive at every threshold: `precision(τ)` counts it against a τ that in truth cleared it, so measured precision reads low and the fit **climbs**. That is why every model-label fit ran high. A too-high `τ_hi` is not the safe error — it rejects candidates the viewer would accept and drops those beats to the fallback ladder, i.e. to the generic stock this doc exists to prevent (`0.360` cleared just 23/218).
>
> **Run `pnpm eval:fixtures` before any eval.** `labels.jsonl` points into `data/cache`, an LRU render cache that evicts the labelled thumbs; a missing thumb used to embed as `[]` and score a silent 0 — every base score the constant 0.266, every ROC-AUC exactly 0.500, and the run still printed `PASS`. `matching.ts` now refuses.
>
> **Two levers, settled on the full human set:** **§1.1 contrastive** is null (pooled +0.0085, CI [−0.0127, +0.0310]; within-beat +0.0210, CI [−0.0201, +0.0622]) — it stays benched, and the +0.0398 "real gain" seen at n=80 was the same subset artifact as `0.338`. **§3.9's caption ranker** is null (pooled −0.0067) — do not build the caption gate. Per the redesign's §3.13 the real label source is the review gate.

```
for each beat in order:
  ranked = candidates sorted by score desc (persist rank + score to DB)
  best = ranked[0]
  if best.score ≥ τ_hi            → choose, done
  if best.score ≥ τ_lo            → choose, flag beat 'weak' (yellow badge in storyboard)
  else                            → FALLBACK LADDER
```

## Step 4 — Fallback ladder (in order; stop at first success = candidate ≥ τ_lo)

1. **Broaden literal**: rule-based query reduction — drop adjectives/modifiers to the head noun phrase (`"rusty farm gate dusk"` → `"farm gate"` → `"gate"`), fire tier-boosted search (video, both providers), score new candidates. Max 2 broadenings. *(Skipped if QuotaGuard says reserve exhausted.)*
2. **Conceptual tier**: fire `queries.conceptual` (video + image), score.
3. **Mood tier**: fire `queries.mood` (video + image), score against a mood-anchored text: embed `"{mood query}, {emotion} atmosphere"` instead of the visualDescription (we're now matching feeling, not content). Accept at `τ_mood < τ_lo` `[CALIBRATE]`.
4. **Generated image** *(only if Phase 13 shipped AND settings allow)*: `POST /genimage` with prompt `"{visualDescription}, cinematic photo, natural light"`, negative "text, watermark, logo"; treat as image candidate with fixed `sim` bonus; Ken Burns in compose.
5. **Text card** (always succeeds): `POST /textcard` with `keyPhrase`, theme from design system + emotion accent (doc 17); insert as `textcard` candidate, choose it.

Every ladder step appends real `candidates` rows (provider `'generated'`/`'textcard'` where applicable) so the storyboard can still offer swaps. Ladder outcomes logged per beat in `stages/score/selection.json`: `{beatIdx, chosen, rungUsed, scores}` — this file is the tuning instrument.

## Step 5 — Global variety pass

After all beats chosen: if > 60% of beats share one provider **author**, re-run selection for the offending beats with the penalty weights doubled (single pass, no loop). Then write `chosen_candidate_id`s.

> **Corrected 2026-07-16 — the doc described a trigger that does not exist.** This line previously
> also promised "*or ≥ 3 consecutive beats are images*". `varietyPass` (`packages/core/src/matching.ts`)
> implements **only** the author-dominance trigger — it returns early unless one author holds > 60%,
> and never inspects `kind`. No consecutive-images check has ever shipped. The doc is corrected to
> match the code rather than the reverse: adding the trigger is a behaviour change to selection, and
> given the penalties it would double are already 7–28× the rank-1 margin (see §Step 2), doubling
> them for a *third* reason should be a deliberate decision with evidence, not a doc-conformance fix.

## Single-beat re-search (storyboard)

`beat-research` job: if user edited `visualDescription` → re-embed; if custom query → fire it (video+image, both providers, quota-checked); merge, re-rank the beat, return top 8 to the drawer. Never touches other beats.

## Why this beats keyword matching (keep in README)

Keyword search retrieves *words*; SigLIP re-ranking retrieves *pictures that look like the sentence's meaning*, and the ladder guarantees the failure mode is "tasteful abstract match or clean typographic card" — never a confusing literal mismatch. The `selection.json` audit trail makes quality measurable and tunable, which is the difference between a demo and a product.
