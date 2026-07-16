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
> and the current fixture cannot: `pnpm eval:kappa` measured κ(model, human) = 0.416 at reliability
> 1.000, i.e. the labels are systematically *biased*, not merely noisy. Re-scaling a constant against
> a biased instrument is how the shipped `τ = 0.322` came to claim 90% precision and deliver 78.8%.
> Whether variety is a hard ban or a soft preference is also a product decision, not an eval result.

## Step 3 — Greedy selection with thresholds

Constants `[CALIBRATE in Phase 6]` against the golden set; SigLIP cosine ranges are model-specific, so calibrate empirically: score 30 hand-labeled (good/bad) beat–thumb pairs, set `τ_hi` at the 90%-precision point and `τ_lo` at 70%.

**Re-calibrated 2026-07-16** (`siglip2-base-patch16-224`, **222 pairs / 30 beats**, `pnpm eval:matching`): `τ_hi = 0.360`, `τ_lo = 0.314`, in **base-score space** (not raw cosine). Scores compress near ~0.30 because the non-sim quality/orient terms are ≈constant for HD stock video, so the discriminating signal is the SigLIP cosine riding on that offset — re-fit both `packages/core/src/constants.ts` and this line whenever the model or the score formula changes.

> The previous values (`τ_hi = 0.322`, `τ_lo = 0.314`, calibrated 2026-07-11) were fitted to **30 pairs from G1–G3** and did not survive more data: that same 30-pair subset still reproduces `0.322/0.314` exactly, while on 222 pairs a score of 0.322 delivers **78.8%** precision on stock-servable beats and **63.7%** overall — not the 90% the confident tier claims. Its reported "precision@1 = 100%" was the metric saturating (every beat in that set contained a good candidate, so the abstain path was never exercised), not evidence of calibration. `τ_lo` is deliberately left at 0.314: its measured @70% point is 0.300, but lowering it would *accept more* marginal candidates, which is not the demonstrated defect.
>
> **Caveat:** 192 of the 222 labels are AI-judged (`labeledBy` in `fixtures/eval/labels.jsonl`) and the beat mix is hand-picked — 0.360 is a better estimate than 0.322, not ground truth. Per the redesign's §3.13 the real label source is the review gate.

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
