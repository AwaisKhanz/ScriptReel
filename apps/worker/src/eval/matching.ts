import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { env, rootDir } from '@scriptreel/config';
import {
  baseScore,
  type CandidateFeatures,
  contrastiveSpec,
  cosine,
  type ScoreContext,
  SPEC_DISTRACTORS,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { z } from 'zod';
import { embedImage, embedText } from '../sidecar/client';

// pnpm eval:matching — score the hand-labeled beat↔thumb set (doc 21), report
// precision@1 and the τ_hi/τ_lo operating points, and print a score histogram.
// Labels carry their own candidate features so the eval needs only the sidecar.

const LabelSchema = z.object({
  beat: z.string(), // group key (precision@1 is per beat)
  beatDescription: z.string(),
  thumbPath: z.string(),
  kind: z.enum(['video', 'image']),
  width: z.number(),
  height: z.number(),
  duration: z.number().nullable(),
  label: z.enum(['good', 'bad']),
  // Provenance. `human` = hand-labelled (doc 21). `model` = judged by a vision model via
  // `pnpm eval:pool`'s labelling workflow. Model labels are defensible here because the question
  // is objective ("is the subject actually present?") rather than taste — but they are NOT
  // independent ground truth: an AUC measured against them scores agreement with a model's
  // opinion, not a human's. Recorded so that can never be forgotten, and reported below.
  labeledBy: z.enum(['human', 'model']).optional(),
});
type Label = z.infer<typeof LabelSchema>;

// Representative context (doc 09): the eval calibrates in the same base-score space
// that the greedy selector compares τ against.
const CTX: ScoreContext = { targetHeight: 1080, targetAspect: 16 / 9, mixedMode: true };
const NOMINAL_BEAT_SEC = 5;

interface Scored extends Label {
  score: number;
  sim: number;
  spec: number; // contrastive-normalised sim (redesign §1.1) — the Phase 1 candidate axis
}

// A recorded run: every pair's scores plus the encoder that produced them. Comparing two SigLIP
// models is a PAIRED question ("on these same pairs, is B better than A?"), but the sidecar only
// ever has one model resident — so the two arms cannot exist in one process. Dump arm A, then run
// arm B with --baseline and join on (beat, thumbPath) to recover the pairing. Without this, model
// A/Bs fall back to comparing two independent AUCs against the ±0.035 single-AUC s.e., which is
// far too blunt to resolve the deltas that matter here.
const RunSchema = z.object({
  model: z.string(),
  pairs: z.array(
    z.object({
      beat: z.string(),
      thumbPath: z.string(),
      label: z.enum(['good', 'bad']),
      sim: z.number(),
      spec: z.number(),
      score: z.number(),
    }),
  ),
});
type Run = z.infer<typeof RunSchema>;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// Ask the sidecar which encoder is loaded — never assert it from our own env, which does not even
// carry SIGLIP_MODEL (that is the sidecar's process env). A mislabelled dump is worse than none.
async function sidecarModel(): Promise<string> {
  try {
    const res = await fetch(`${env.SIDECAR_URL}/health`, { signal: AbortSignal.timeout(10_000) });
    const j: unknown = await res.json();
    const v = (j as { versions?: Record<string, string> }).versions;
    return v?.siglipModel ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function labelsPath(): string {
  return resolve(rootDir, 'fixtures/eval/labels.jsonl');
}

async function loadLabels(): Promise<Label[]> {
  const raw = await readFile(labelsPath(), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l, i) => {
      const parsed = LabelSchema.safeParse(JSON.parse(l));
      if (!parsed.success) throw new Error(`labels.jsonl line ${i + 1}: ${parsed.error.message}`);
      return parsed.data;
    });
}

// Precision-at-threshold curve: precision(τ) = #good with value≥τ / #all with value≥τ.
// `axisOf` picks the axis — base score (τ_hi/τ_lo) or raw sim (cross-check floor, 23d).
// τ_hi = lowest τ reaching 90% precision, τ_lo = 70% (doc 09 §step 3, doc 21).
function operatingPoint(
  scored: Scored[],
  axisOf: (s: Scored) => number,
  targetPrecision: number,
  minSupport: number,
): number | null {
  const thresholds = [...new Set(scored.map(axisOf))].sort((a, b) => a - b);
  for (const tau of thresholds) {
    const at = scored.filter((s) => axisOf(s) >= tau);
    if (at.length < minSupport) continue;
    const precision = at.filter((s) => s.label === 'good').length / at.length;
    if (precision >= targetPrecision) return tau;
  }
  return null;
}

// Rank-based ROC-AUC (Mann–Whitney U), average ranks for ties. Threshold-free: "what is
// P(a random good outranks a random bad)?" — 0.5 is a coin flip, 1.0 is perfect separation.
// This is the metric a CALIBRATION change moves. precision@1 cannot see one: with 6 beats that
// all contain a good candidate it saturates at 100%, so a large separability gain reads as "no
// change". Report AUC on the base score AND on raw sim (the subject-presence axis).
function rocAuc(scored: Scored[], axisOf: (s: Scored) => number): number | null {
  const pos = scored.filter((s) => s.label === 'good');
  const neg = scored.filter((s) => s.label === 'bad');
  if (pos.length === 0 || neg.length === 0) return null;
  const all = [
    ...pos.map((s) => ({ v: axisOf(s), good: true })),
    ...neg.map((s) => ({ v: axisOf(s), good: false })),
  ].sort((a, b) => a.v - b.v);
  // Average ranks within tie groups — otherwise ties bias the U statistic.
  const ranks = new Array<number>(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]?.v === all[i]?.v) j += 1;
    const avgRank = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k += 1) ranks[k] = avgRank;
    i = j + 1;
  }
  const sumPosRanks = all.reduce((acc, x, idx) => acc + (x.good ? (ranks[idx] ?? 0) : 0), 0);
  const n1 = pos.length;
  const n2 = neg.length;
  return (sumPosRanks - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

// Paired bootstrap CI for the DIFFERENCE between two ranking axes (B resamples, stratified by
// label, both axes scored on the SAME resample so the comparison stays paired).
//
// Why this and not the printed s.e.: that number is the standard error of ONE AUC (~±0.035 here),
// which is the wrong yardstick for "is axis B better than axis A on these same pairs". A paired
// comparison cancels the shared pair-to-pair variance and has far more power, so a delta well
// under the single-AUC s.e. can still be real — or still be nothing. Only this can tell them
// apart, and every remaining decision in the redesign is exactly such a comparison.
//
// The RNG is seeded and deterministic: a calibration fixture that returns different CIs each run
// is not a fixture. Returns the observed delta plus the 95% interval.
function bootstrapDeltaAuc(
  scored: Scored[],
  axisA: (s: Scored) => number,
  axisB: (s: Scored) => number,
  reps = 2000,
): { delta: number; lo: number; hi: number; significant: boolean } | null {
  const good = scored.filter((s) => s.label === 'good');
  const bad = scored.filter((s) => s.label === 'bad');
  if (good.length < 2 || bad.length < 2) return null;
  const a0 = rocAuc(scored, axisA);
  const b0 = rocAuc(scored, axisB);
  if (a0 == null || b0 == null) return null;

  let seed = 987654321;
  const rnd = (): number => {
    // xorshift32 — small, deterministic, good enough for resampling indices
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const draw = (xs: Scored[], n: number): Scored[] =>
    Array.from({ length: n }, () => xs[Math.floor(rnd() * xs.length)] as Scored);

  const deltas: number[] = [];
  for (let i = 0; i < reps; i += 1) {
    const sample = [...draw(good, good.length), ...draw(bad, bad.length)];
    const a = rocAuc(sample, axisA);
    const b = rocAuc(sample, axisB);
    if (a != null && b != null) deltas.push(b - a);
  }
  deltas.sort((x, y) => x - y);
  const lo = deltas[Math.floor(deltas.length * 0.025)] ?? 0;
  const hi = deltas[Math.floor(deltas.length * 0.975)] ?? 0;
  return { delta: b0 - a0, lo, hi, significant: !(lo <= 0 && hi >= 0) };
}

// Mean WITHIN-BEAT AUC — averaged over beats that contain both a good and a bad candidate.
//
// This is the diagnostic the pooled AUC cannot give. Pooled AUC ranks every candidate against
// every other, so it compares a "kneading dough" candidate with a "Neil Armstrong" one — different
// questions — and therefore measures cross-beat COMPARABILITY as much as ranking skill. SigLIP's
// raw cosine drifts with prompt phrasing/length, so that confound is large and is exactly what a
// pooled number hides.
//
// Within-beat AUC asks only "for THIS beat, does the axis put its good candidates above its bad
// ones?" — which is the question the selector actually answers. Split the two:
//   within HIGH + pooled LOW  ⇒ ranking is fine; the scores just aren't comparable across beats
//                               ⇒ fix = per-beat normalisation / margin, NOT a bigger encoder.
//   within LOW                ⇒ the encoder genuinely cannot tell these apart ⇒ a model problem.
// Beats that are all-good or all-bad have no within-beat AUC (undefined) and are skipped — the
// h* beats therefore contribute to `pooled` only.
function withinBeatAuc(
  scored: Scored[],
  axisOf: (s: Scored) => number,
): { mean: number; beats: number } | null {
  const aucs: number[] = [];
  for (const beat of [...new Set(scored.map((s) => s.beat))]) {
    const group = scored.filter((s) => s.beat === beat);
    if (!group.some((s) => s.label === 'good') || !group.some((s) => s.label === 'bad')) continue;
    const a = rocAuc(group, axisOf);
    if (a != null) aucs.push(a);
  }
  return aucs.length > 0 ? { mean: mean(aucs), beats: aucs.length } : null;
}

// Paired CLUSTER bootstrap for the within-beat ΔAUC: resamples BEATS (not candidates) with
// replacement, because the beat is the independent unit — candidates inside one beat share a
// description and are correlated, so resampling them individually would understate the variance
// and manufacture significance.
//
// This is the correct test for "does axis B rank better than A inside a beat?", which is the only
// ranking the selector ever performs. The pooled test answers a different question (cross-beat
// comparability) and can hide a real within-beat effect entirely.
function bootstrapWithinBeatDelta(
  scored: Scored[],
  axisA: (s: Scored) => number,
  axisB: (s: Scored) => number,
  reps = 2000,
): { delta: number; lo: number; hi: number; significant: boolean; beats: number } | null {
  const mixed = [...new Set(scored.map((s) => s.beat))].filter((b) => {
    const g = scored.filter((s) => s.beat === b);
    return g.some((s) => s.label === 'good') && g.some((s) => s.label === 'bad');
  });
  if (mixed.length < 3) return null;
  const byBeat = new Map(mixed.map((b) => [b, scored.filter((s) => s.beat === b)]));
  const meanDelta = (bs: string[]): number => {
    const ds: number[] = [];
    for (const b of bs) {
      const g = byBeat.get(b);
      if (!g) continue;
      const a = rocAuc(g, axisA);
      const bb = rocAuc(g, axisB);
      if (a != null && bb != null) ds.push(bb - a);
    }
    return mean(ds);
  };
  const observed = meanDelta(mixed);
  let seed = 424242;
  const rnd = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const deltas: number[] = [];
  for (let i = 0; i < reps; i += 1) {
    const sample = Array.from(
      { length: mixed.length },
      () => mixed[Math.floor(rnd() * mixed.length)] as string,
    );
    deltas.push(meanDelta(sample));
  }
  deltas.sort((x, y) => x - y);
  const lo = deltas[Math.floor(deltas.length * 0.025)] ?? 0;
  const hi = deltas[Math.floor(deltas.length * 0.975)] ?? 0;
  return { delta: observed, lo, hi, significant: !(lo <= 0 && hi >= 0), beats: mixed.length };
}

// Standardised mean difference. Quantifies the core bug: a good/bad gap of ~0.03 against
// penalties of 0.05–0.25 means a single lever outvotes the semantic signal entirely.
function cohensD(good: number[], bad: number[]): number {
  if (good.length < 2 || bad.length < 2) return 0;
  const vg = variance(good);
  const vb = variance(bad);
  const pooled = Math.sqrt(
    ((good.length - 1) * vg + (bad.length - 1) * vb) / (good.length + bad.length - 2),
  );
  return pooled > 0 ? (mean(good) - mean(bad)) / pooled : 0;
}

// Per-beat rank-1 margin (top1 − top2). This IS the `spec_margin` δ the redesign proposes as the
// accept rule in place of an absolute τ, so it's the number to watch when contrastive
// normalisation lands: the margin should widen even if precision@1 stays pinned at 100%.
function margins(
  scored: Scored[],
  axisOf: (s: Scored) => number,
): { beat: string; margin: number; topGood: boolean }[] {
  const out: { beat: string; margin: number; topGood: boolean }[] = [];
  for (const beat of [...new Set(scored.map((s) => s.beat))]) {
    const group = scored.filter((s) => s.beat === beat).sort((a, b) => axisOf(b) - axisOf(a));
    const t1 = group[0];
    const t2 = group[1];
    if (!t1 || !t2) continue;
    out.push({ beat, margin: axisOf(t1) - axisOf(t2), topGood: t1.label === 'good' });
  }
  return out;
}

function histogram(scored: Scored[]): string {
  const buckets = new Map<string, { good: number; bad: number }>();
  const bucketFor = (x: number): string => {
    const lo = Math.floor(x * 20) / 20; // 0.05-wide buckets
    return lo.toFixed(2);
  };
  for (const s of scored) {
    const key = bucketFor(s.score);
    const b = buckets.get(key) ?? { good: 0, bad: 0 };
    if (s.label === 'good') b.good += 1;
    else b.bad += 1;
    buckets.set(key, b);
  }
  const rows = [...buckets.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const bar = (g: number, bd: number): string => '█'.repeat(g) + '░'.repeat(bd);
  return rows
    .map(
      ([k, v]) =>
        `  ${k}–${(Number(k) + 0.05).toFixed(2)}  ${bar(v.good, v.bad)}  (${v.good}✓ ${v.bad}✗)`,
    )
    .join('\n');
}

async function main(): Promise<void> {
  const labels = await loadLabels();
  if (labels.length === 0) throw new Error('no labels found in fixtures/eval/labels.jsonl');

  // Embed unique descriptions + unique thumbs (cached on disk by the sidecar).
  const descriptions = [...new Set(labels.map((l) => l.beatDescription))];
  const thumbPaths = [...new Set(labels.map((l) => l.thumbPath))].map((p) =>
    isAbsolute(p) ? p : resolve(rootDir, p),
  );
  const descRes = await embedText(descriptions);
  const descByText = new Map(descriptions.map((t, i) => [t, descRes.vectors[i] ?? []]));
  // The distractor bank is fixed and beat-independent — embed once (redesign §1.1).
  const distractorEmbs = (await embedText([...SPEC_DISTRACTORS])).vectors;
  const thumbByPath = new Map<string, number[]>();
  for (let i = 0; i < thumbPaths.length; i += 64) {
    const batch = thumbPaths.slice(i, i + 64);
    const res = await embedImage(batch);
    batch.forEach((p, j) => {
      if (!res.failed.includes(p)) thumbByPath.set(p, res.vectors[j] ?? []);
    });
  }

  const scored: Scored[] = labels.map((l) => {
    const descEmb = descByText.get(l.beatDescription) ?? [];
    const abs = isAbsolute(l.thumbPath) ? l.thumbPath : resolve(rootDir, l.thumbPath);
    const thumbEmb = thumbByPath.get(abs) ?? [];
    const sim = cosine(descEmb, thumbEmb);
    const spec = contrastiveSpec(thumbEmb, descEmb, distractorEmbs);
    const features: CandidateFeatures = {
      kind: l.kind,
      isIllustration: false,
      width: l.width,
      height: l.height,
      durationSec: l.duration,
      fps: null,
    };
    return { ...l, sim, spec, score: baseScore(sim, features, CTX, NOMINAL_BEAT_SEC).base };
  });

  const good = scored.filter((s) => s.label === 'good');
  const bad = scored.filter((s) => s.label === 'bad');
  const tauHi = operatingPoint(scored, (s) => s.score, 0.9, 3);
  const tauLo = operatingPoint(scored, (s) => s.score, 0.7, 3);
  // Raw-sim cross-check floor (doc 23 §6): the subject-presence axis, independent of
  // the quality/orient terms that can lift a wrong-but-pretty asset over the base τ.
  const simFloorHi = operatingPoint(scored, (s) => s.sim, 0.9, 3);
  const simFloorLo = operatingPoint(scored, (s) => s.sim, 0.8, 3);

  // precision@1 / top-1 acceptance (doc 21): per beat, is rank-1 good? For all-bad
  // beats, a correct decline (top score < τ_lo) also counts as accepted.
  const beats = [...new Set(scored.map((s) => s.beat))];
  const lo = tauLo ?? Number.POSITIVE_INFINITY;
  let accepted = 0;
  const perBeat: string[] = [];
  for (const beat of beats) {
    const group = scored.filter((s) => s.beat === beat).sort((a, b) => b.score - a.score);
    const top = group[0];
    if (!top) continue;
    const hasGood = group.some((s) => s.label === 'good');
    let ok: boolean;
    if (hasGood) ok = top.label === 'good';
    else ok = top.score < lo; // correctly declines when everything is bad
    if (ok) accepted += 1;
    perBeat.push(
      `  ${beat.padEnd(8)} top=${top.score.toFixed(3)} (${top.label}) hasGood=${hasGood} → ${ok ? 'accept' : 'MISS'}`,
    );
  }
  const precisionAt1 = accepted / beats.length;

  console.log('=== eval:matching (doc 21) ===');
  console.log(
    `pairs: ${scored.length}  (${good.length} good, ${bad.length} bad)  beats: ${beats.length}`,
  );
  // Surface provenance on every run: most of this fixture is model-judged, so these numbers
  // measure agreement with a vision model's opinion, not human ground truth. Per the plan's
  // §3.13 the real source is the review gate. Strong evidence, not proof.
  const byModel = scored.filter((s) => s.labeledBy === 'model').length;
  const byHuman = scored.filter((s) => s.labeledBy === 'human').length;
  console.log(
    `labels: ${byHuman} human · ${byModel} model${byModel > 0 ? '  ⚠ model labels are strong evidence, not ground truth' : ''}`,
  );
  console.log(
    `good score  mean=${mean(good.map((s) => s.score)).toFixed(3)}  min=${min(good.map((s) => s.score)).toFixed(3)}`,
  );
  console.log(
    `bad  score  mean=${mean(bad.map((s) => s.score)).toFixed(3)}  max=${max(bad.map((s) => s.score)).toFixed(3)}`,
  );
  console.log(
    `good sim    mean=${mean(good.map((s) => s.sim)).toFixed(3)}  min=${min(good.map((s) => s.sim)).toFixed(3)}`,
  );
  console.log(
    `bad  sim    mean=${mean(bad.map((s) => s.sim)).toFixed(3)}  max=${max(bad.map((s) => s.sim)).toFixed(3)}`,
  );
  console.log('\nscore histogram (✓=good ░=bad):');
  console.log(histogram(scored));
  // Separability — threshold-free, and the axis a calibration change actually moves.
  const aucScore = rocAuc(scored, (s) => s.score);
  const aucSim = rocAuc(scored, (s) => s.sim);
  const dScore = cohensD(
    good.map((s) => s.score),
    bad.map((s) => s.score),
  );
  const marginVals = margins(scored, (s) => s.score)
    .map((m) => m.margin)
    .sort((a, b) => a - b);
  const medianMargin = marginVals[Math.floor(marginVals.length / 2)] ?? 0;
  console.log('\nseparability (threshold-free — what a calibration fix moves):');
  console.log(`  ROC-AUC base score = ${fmt(aucScore)}   (0.5 = coin flip, 1.0 = perfect)`);
  console.log(`  ROC-AUC raw sim    = ${fmt(aucSim)}`);
  // Pooled vs within-beat: the diagnostic that says whether a low pooled number means "can't
  // rank" or merely "scores aren't comparable across beats" (see withinBeatAuc).
  const wSim = withinBeatAuc(scored, (s) => s.sim);
  const wSpec = withinBeatAuc(scored, (s) => s.spec);
  const wScore = withinBeatAuc(scored, (s) => s.score);
  console.log(
    `  within-beat AUC    = sim ${wSim ? wSim.mean.toFixed(3) : 'n/a'} · spec ${wSpec ? wSpec.mean.toFixed(3) : 'n/a'} · score ${wScore ? wScore.mean.toFixed(3) : 'n/a'}   (mean over ${wSim?.beats ?? 0} mixed beats)`,
  );
  if (wSim && aucSim != null) {
    const gap = wSim.mean - aucSim;
    console.log(
      `  within − pooled    = ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}${gap > 0.05 ? '  → ranks well WITHIN a beat; the loss is cross-beat comparability (per-beat normalisation, not a bigger model)' : gap < -0.05 ? '  → worse within a beat than pooled — beats differ in difficulty' : '  → no material gap'}`,
    );
  }
  console.log(`  Cohen's d (score)  = ${dScore.toFixed(3)}   (0.2 small · 0.5 medium · 0.8 large)`);
  console.log('\nrank-1 margin, top1−top2 (the §1.1 spec_margin δ):');
  console.log(
    `  mean=${mean(marginVals).toFixed(4)}  median=${medianMargin.toFixed(4)}  min=${min(marginVals).toFixed(4)}  max=${max(marginVals).toFixed(4)}`,
  );

  // ---- Phase 1 experiment: does contrastive normalisation actually separate better? ----
  // Compared on the SAME pairs, rank-based, so the differing absolute scale of sim vs spec is
  // irrelevant to AUC. This is the decision: adopt spec only if it beats the raw cosine here.
  const aucSpec = rocAuc(scored, (s) => s.spec);
  // Baseline must be sim, NOT the base score: spec replaces the raw cosine, so comparing it to a
  // score that also carries the quality/orient terms would not be like-for-like.
  const dSim = cohensD(
    good.map((s) => s.sim),
    bad.map((s) => s.sim),
  );
  const dSpec = cohensD(
    good.map((s) => s.spec),
    bad.map((s) => s.spec),
  );
  const simMarginVals = margins(scored, (s) => s.sim)
    .map((m) => m.margin)
    .sort((a, b) => a - b);
  const specMarginVals = margins(scored, (s) => s.spec)
    .map((m) => m.margin)
    .sort((a, b) => a - b);
  const simTop1Good = margins(scored, (s) => s.sim).filter((m) => m.topGood).length;
  const specTop1Good = margins(scored, (s) => s.spec).filter((m) => m.topGood).length;
  const beatsWithPair = margins(scored, (s) => s.sim).length;
  console.log('\n── §1.1 contrastive normalisation: spec = cos(I,T) − mean_j cos(I,D_j) ──');
  console.log(`  distractor bank    = ${SPEC_DISTRACTORS.length} prompts`);
  console.log(`  ROC-AUC raw sim    = ${fmt(aucSim)}`);
  console.log(`  ROC-AUC spec       = ${fmt(aucSpec)}   ${verdict(aucSim, aucSpec)}`);
  console.log(`  Cohen's d  sim→spec= ${dSim.toFixed(3)} → ${dSpec.toFixed(3)}`);
  console.log(
    `  margin min sim→spec= ${min(simMarginVals).toFixed(4)} → ${min(specMarginVals).toFixed(4)}   (worst-case top1−top2)`,
  );
  console.log(
    `  margin/σ   sim→spec= ${marginOverSigma(
      simMarginVals,
      scored.map((s) => s.sim),
    ).toFixed(3)} → ${marginOverSigma(
      specMarginVals,
      scored.map((s) => s.spec),
    ).toFixed(3)}   (scale-free: median margin ÷ axis σ)`,
  );
  console.log(
    `  top-1 good sim→spec = ${simTop1Good}/${beatsWithPair} → ${specTop1Good}/${beatsWithPair}`,
  );
  // The single-AUC s.e. — context only. It is NOT the test for the paired comparisons below.
  console.log(
    `  (single-AUC s.e. ≈ ±${(Math.sqrt(0.85 * 0.15) / Math.sqrt(Math.min(good.length, bad.length))).toFixed(3)} at n=${scored.length} — the paired CIs below are the actual test)`,
  );

  // ---- The decisions, tested properly: paired bootstrap on the same pairs. ----
  const call = (
    r: { delta: number; lo: number; hi: number; significant: boolean } | null,
  ): string =>
    r == null
      ? 'n/a'
      : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)}  95% CI [${r.lo >= 0 ? '+' : ''}${r.lo.toFixed(4)}, ${r.hi >= 0 ? '+' : ''}${r.hi.toFixed(4)}]  → ${
          r.significant
            ? r.delta > 0
              ? 'REAL improvement'
              : 'REAL regression'
            : 'no effect (CI spans 0)'
        }`;
  console.log('\n── POOLED paired bootstrap ΔAUC (2000 resamples) — cross-beat comparability ──');
  console.log(
    `  spec − sim   (§1.1 contrastive)  = ${call(
      bootstrapDeltaAuc(
        scored,
        (s) => s.sim,
        (s) => s.spec,
      ),
    )}`,
  );
  console.log(
    `  base − sim   (§1.2 extra terms)  = ${call(
      bootstrapDeltaAuc(
        scored,
        (s) => s.sim,
        (s) => s.score,
      ),
    )}`,
  );

  // The decision that actually matters: the selector only ever ranks WITHIN a beat, so a pooled
  // null can hide a real within-beat win. Cluster-bootstrapped over beats (the independent unit).
  const wCall = (
    r: { delta: number; lo: number; hi: number; significant: boolean; beats: number } | null,
  ): string =>
    r == null
      ? 'n/a'
      : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)}  95% CI [${r.lo >= 0 ? '+' : ''}${r.lo.toFixed(4)}, ${r.hi >= 0 ? '+' : ''}${r.hi.toFixed(4)}]  (${r.beats} beats)  → ${
          r.significant
            ? r.delta > 0
              ? 'REAL improvement'
              : 'REAL regression'
            : 'no effect (CI spans 0)'
        }`;
  console.log('\n── WITHIN-BEAT cluster bootstrap ΔAUC — the ranking the selector performs ──');
  console.log(
    `  spec − sim   (§1.1 contrastive)  = ${wCall(
      bootstrapWithinBeatDelta(
        scored,
        (s) => s.sim,
        (s) => s.spec,
      ),
    )}`,
  );
  console.log(
    `  base − sim   (§1.2 extra terms)  = ${wCall(
      bootstrapWithinBeatDelta(
        scored,
        (s) => s.sim,
        (s) => s.score,
      ),
    )}`,
  );

  console.log('\noperating points (base-score space):');
  console.log(`  τ_hi @90% precision = ${fmt(tauHi)}`);
  console.log(`  τ_lo @70% precision = ${fmt(tauLo)}`);
  console.log('\ncross-check sim floor (raw-sim space, doc 23 §6):');
  console.log(`  sim @90% precision  = ${fmt(simFloorHi)}   ← CROSSCHECK_SIM_FLOOR candidate`);
  console.log(`  sim @80% precision  = ${fmt(simFloorLo)}`);
  // ---- Model A/B: record this run, and/or paired-compare it against a recorded baseline. ----
  const model = await sidecarModel();
  const dumpPath = argValue('--dump');
  if (dumpPath) {
    const run: Run = {
      model,
      pairs: scored.map((s) => ({
        beat: s.beat,
        thumbPath: s.thumbPath,
        label: s.label,
        sim: s.sim,
        spec: s.spec,
        score: s.score,
      })),
    };
    await writeFile(resolve(rootDir, dumpPath), JSON.stringify(run), 'utf8');
    console.log(`\ndumped ${run.pairs.length} pairs for model "${model}" → ${dumpPath}`);
  }

  const baselinePath = argValue('--baseline');
  if (baselinePath) {
    const base = RunSchema.parse(
      JSON.parse(await readFile(resolve(rootDir, baselinePath), 'utf8')),
    );
    const key = (p: { beat: string; thumbPath: string }): string => `${p.beat}|${p.thumbPath}`;
    const baseByKey = new Map(base.pairs.map((p) => [key(p), p]));
    // Join so both arms are the SAME pairs; anything unmatched is dropped rather than guessed.
    const joined = scored.filter((s) => baseByKey.has(key(s)));
    console.log(`\n── model A/B (paired on ${joined.length}/${scored.length} joined pairs) ──`);
    console.log(`  A (baseline) = ${base.model}`);
    console.log(`  B (current)  = ${model}`);
    if (base.model === model) {
      console.log('  ⚠ both arms are the SAME model — this compares nothing.');
    }
    if (joined.length < scored.length) {
      console.log(
        `  ⚠ ${scored.length - joined.length} pairs missing from the baseline — dropped.`,
      );
    }
    // Re-key each axis onto the joined rows: axisA reads the baseline's value for that same pair.
    const withBase = joined.map((s) => ({
      ...s,
      _b: baseByKey.get(key(s)) as Run['pairs'][number],
    }));
    const rep = (
      name: string,
      a: (s: (typeof withBase)[number]) => number,
      b: (s: (typeof withBase)[number]) => number,
    ): void => {
      const aucA = rocAuc(withBase as unknown as Scored[], a as unknown as (s: Scored) => number);
      const aucB = rocAuc(withBase as unknown as Scored[], b as unknown as (s: Scored) => number);
      const r = bootstrapDeltaAuc(
        withBase as unknown as Scored[],
        a as unknown as (s: Scored) => number,
        b as unknown as (s: Scored) => number,
      );
      console.log(
        `  ${name.padEnd(6)} AUC ${fmt(aucA)} → ${fmt(aucB)}   Δ=${r ? `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(4)} CI [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}] → ${r.significant ? (r.delta > 0 ? 'REAL improvement' : 'REAL regression') : 'no effect (CI spans 0)'}` : 'n/a'}`,
      );
    };
    rep(
      'sim',
      (s) => s._b.sim,
      (s) => s.sim,
    );
    rep(
      'score',
      (s) => s._b.score,
      (s) => s.score,
    );
  }

  console.log('\nper-beat top-1:');
  console.log(perBeat.join('\n'));
  console.log(
    `\nprecision@1 (top-1 acceptance) = ${(precisionAt1 * 100).toFixed(1)}%  (gate ≥55%: ${precisionAt1 >= 0.55 ? 'PASS' : 'FAIL'})`,
  );
  await db.closeDb();
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1); // sample variance
};
const min = (xs: number[]): number => (xs.length ? Math.min(...xs) : 0);
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);
const fmt = (x: number | null): string => (x == null ? 'n/a (never reaches target)' : x.toFixed(3));
// sim and spec live on different scales, so raw margins aren't comparable. Dividing the median
// margin by the axis's own spread makes the comparison scale-free: "how many σ separates rank 1
// from rank 2?" — which is what the §1.1 accept rule actually needs.
const marginOverSigma = (marginVals: number[], axisVals: number[]): number => {
  const sd = Math.sqrt(variance(axisVals));
  const median = marginVals[Math.floor(marginVals.length / 2)] ?? 0;
  return sd > 0 ? median / sd : 0;
};
// Plain-language call on the A/B, so the run itself says whether §1.1 earns its place.
const verdict = (before: number | null, after: number | null): string => {
  if (before == null || after == null) return '';
  const d = after - before;
  const tag = d > 0.02 ? 'BETTER' : d < -0.02 ? 'WORSE' : 'no real change';
  return `(${d >= 0 ? '+' : ''}${d.toFixed(3)} vs raw sim → ${tag})`;
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
