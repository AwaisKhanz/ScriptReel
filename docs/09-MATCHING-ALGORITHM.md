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

**Re-calibrated 2026-07-17** (`siglip2-base-patch16-224`, **80 HUMAN labels / 30 beats**, `pnpm eval:matching --human-only`): `τ_hi = 0.338`, `τ_lo = 0.308`, in **base-score space** (not raw cosine). ROC-AUC base 0.788 (raw sim 0.742), precision@1 93.3%. Scores compress near ~0.30 because the non-sim quality/orient terms are ≈constant for HD stock video, so the discriminating signal is the SigLIP cosine riding on that offset — re-fit both `packages/core/src/constants.ts` and this line whenever the model or the score formula changes.

> **Why 0.360/0.314 are void.** The rule pre-registered in `eval/kappa.ts` — fixed before any human label was collected — said `κ ≤ 0.30 → the fixture measures the model's taste; every decision taken against it, τ = 0.360 included, is void`. On 50 blind human labels, **κ = 0.160**. The vision judge that produced 192 of those 222 labels does not measure what a human means by "good", and it is biased rather than noisy: it disagrees **16:5** in one direction (8:1 at n=30, so it reproduces), demanding literal subject presence where the human accepts thematic fit. ~44% of the 192 are wrong, mostly `bad` that should be `good`.
>
> **Direction is the point.** A mislabelled-bad pair is a phantom false-positive at every threshold: `precision(τ)` counts it against a τ that in truth cleared it, so measured precision reads low and the fit climbs to compensate. Both old fits ran **high**. A too-high `τ_hi` is not a safe error — it rejects candidates the viewer would accept and drops those beats to the fallback ladder, i.e. to the generic stock this doc exists to prevent. On the corrected label set, `τ_hi @90%` is **unreachable**: 0.360 was never an attainable operating point, only an artifact of a "servable subset" carved out of bad labels.
>
> **The run that produced it was scoring nothing.** All 222 labeled thumbs had been evicted from `data/cache` (an LRU render cache that `labels.jsonl` points into). Every embed failed, every base score was the constant **0.266**, every ROC-AUC exactly **0.500**, every bootstrap CI zero-width — and `eval:matching` still printed `precision@1 = 76.7% PASS`. It now refuses; run `pnpm eval:fixtures` first. Two conclusions drawn from that run also fall: **§1.1 contrastive** was declared null and benched, but on human labels it shows a real pooled gain (+0.0398, CI [+0.0048, +0.0783]) — reopen it; and **§3.9's caption ranker** "+0.2075 REAL improvement" was a caption axis beating a constant zero, measuring **+0.0573, CI [−0.0052, +0.1406] → null** on real data. Do not build the caption gate.
>
> **Caveat:** n=80 across 30 beats is small, and this exact file has been burned by a small-n fit before — `0.322` reproduced *exactly* on its own 30-pair subset, which is what overfitting looks like. `0.338` is the best-evidenced number available (labels a human wrote, on thumbs that loaded), not ground truth. Widen the human set before trusting it further. Per the redesign's §3.13 the real label source is the review gate.

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
