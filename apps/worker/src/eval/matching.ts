import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
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
  // Honesty guard: with 16 good / 14 bad the AUC standard error is ~0.09, so a delta smaller
  // than that is indicative, not proven. Growing the fixture is what turns this into a decision.
  console.log(
    `  ⚠ n=${scored.length} (${good.length}/${bad.length}) → AUC s.e. ≈ ±${(Math.sqrt(0.85 * 0.15) / Math.sqrt(Math.min(good.length, bad.length))).toFixed(3)}: treat a small delta as indicative only`,
  );

  console.log('\noperating points (base-score space):');
  console.log(`  τ_hi @90% precision = ${fmt(tauHi)}`);
  console.log(`  τ_lo @70% precision = ${fmt(tauLo)}`);
  console.log('\ncross-check sim floor (raw-sim space, doc 23 §6):');
  console.log(`  sim @90% precision  = ${fmt(simFloorHi)}   ← CROSSCHECK_SIM_FLOOR candidate`);
  console.log(`  sim @80% precision  = ${fmt(simFloorLo)}`);
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
