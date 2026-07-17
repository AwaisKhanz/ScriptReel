import { existsSync } from 'node:fs';
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
  // `pnpm eval:pool`'s labelling workflow.
  //
  // Model labels were argued to be defensible here "because the question is objective (is the
  // subject actually present?) rather than taste". MEASURED 2026-07-17, and that argument is
  // dead: `pnpm eval:kappa --score` over 50 blind human labels returns κ = 0.160 — POOR, barely
  // above chance. The question is NOT objective. The model demands literal subject presence; the
  // human accepts thematic fit, and they disagree 16:5 in that direction (8:1 at n=30, so it
  // reproduces). Extrapolated over the pool, ~44% of the 192 model labels are wrong, mostly
  // `bad` that should be `good`.
  //
  // Consequence for anything fitted below: those mislabels are phantom false-positives at every
  // threshold, so precision(τ) reads low and τ climbs to compensate. Any τ fitted on the model
  // labels is too HIGH. Prefer --human-only; the pre-registered rule in kappa.ts voids the rest.
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
  // §3.9 second ranker: cos(bge(visualDescription), bge(florence2_caption)). null when the fixture
  // has no caption for this thumb (produced out-of-process — see services/ml/scripts/caption_sim.py).
  captionSim: number | null;
  rrf: number; // reciprocal-rank fusion of the sim and caption rankings, within the beat
}

// RRF's k. 60 is the constant from Cormack et al. 2009, where RRF was introduced — kept at the
// literature default deliberately: tuning k on the same 30-beat fixture used to judge the method
// would be fitting the fusion to its own test set, which is how §1.1 got its phantom +0.040.
const RRF_K = 60;

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

const HumanVerdictSchema = z.object({
  beat: z.string(),
  thumbPath: z.string(),
  human: z.enum(['good', 'bad']),
});

// Overlay every blind human verdict onto the label set (joined on beat|thumbPath), promoting each
// overwritten row to labeledBy:'human'.
//
//   kappa-human.jsonl — the 50-pair κ round (`pnpm eval:kappa`)
//   kappa-rest.jsonl  — the remaining model-judged pairs (`pnpm eval:kappa --rest`)
//
// These are the SAME pairs the model judged, re-judged by hand without seeing the model's call —
// which is what makes them a correction rather than a second opinion. Where they land, the human
// wins: κ = 0.160 says the model's verdict on those pairs carries almost no signal. Kept as an
// overlay rather than merged into labels.jsonl so the model's original call stays on disk and
// eval:kappa can keep scoring the two against each other.
const HUMAN_VERDICT_FILES = ['fixtures/eval/kappa-human.jsonl', 'fixtures/eval/kappa-rest.jsonl'];

async function applyHumanVerdicts(labels: Label[]): Promise<{ labels: Label[]; applied: number }> {
  const byKey = new Map<string, 'good' | 'bad'>();
  for (const file of HUMAN_VERDICT_FILES) {
    const p = resolve(rootDir, file);
    if (!existsSync(p)) continue;
    const raw = await readFile(p, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length === 0 || t.startsWith('//')) continue;
      const v = HumanVerdictSchema.parse(JSON.parse(t));
      byKey.set(`${v.beat}|${v.thumbPath}`, v.human);
    }
  }
  if (byKey.size === 0) return { labels, applied: 0 };
  let applied = 0;
  const out = labels.map((l) => {
    const verdict = byKey.get(`${l.beat}|${l.thumbPath}`);
    if (!verdict) return l;
    applied += 1;
    return { ...l, label: verdict, labeledBy: 'human' as const };
  });
  return { labels: out, applied };
}

// Precision-at-threshold curve: precision(τ) = #good with value≥τ / #all with value≥τ.
// `axisOf` picks the axis — base score (τ_hi/τ_lo) or raw sim (cross-check floor, 23d).
// τ_hi = lowest τ reaching 90% precision, τ_lo = 70% (doc 09 §step 3, doc 21).
// §3.9 caption sims, keyed `${beat}|${thumbPath}`. Computed out-of-process because the axis needs a
// text<->text encoder (BGE) that the sidecar has no reason to host unless this experiment wins —
// see services/ml/scripts/caption_sim.py. Absent file = axis simply not reported.
async function loadCaptionSims(): Promise<Map<string, number> | null> {
  const p = resolve(rootDir, 'fixtures/eval/.caption-sim.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  const parsed = z.record(z.string(), z.number()).parse(JSON.parse(raw));
  return new Map(Object.entries(parsed));
}

// Reciprocal-rank fusion (Cormack et al. 2009) of the two rankers, computed WITHIN each beat.
// RRF consumes ranks, and ranks only exist relative to a candidate pool — so the fused score is
// meaningful within a beat and meaningless across beats. That is not a limitation to work around:
// the selector only ever ranks within a beat, so this matches what production actually does. It
// does mean the pooled AUC of `rrf` is uninterpretable, and only the within-beat test counts.
function fuseRrf(scored: Scored[]): void {
  for (const beat of new Set(scored.map((s) => s.beat))) {
    const group = scored.filter((s) => s.beat === beat);
    if (group.some((s) => s.captionSim == null)) continue; // partial captions → leave rrf at sim-only
    const bySim = [...group].sort((a, b) => b.sim - a.sim);
    const byCap = [...group].sort((a, b) => (b.captionSim ?? 0) - (a.captionSim ?? 0));
    const rankSim = new Map(bySim.map((s, i) => [s, i + 1]));
    const rankCap = new Map(byCap.map((s, i) => [s, i + 1]));
    for (const s of group) {
      s.rrf = 1 / (RRF_K + (rankSim.get(s) ?? 0)) + 1 / (RRF_K + (rankCap.get(s) ?? 0));
    }
  }
}

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

// The best precision this axis reaches at ANY threshold, with the τ and coverage there. `n/a` from
// operatingPoint says a target was missed; it does not say by how much, or whether the target was
// ever attainable. That distinction is the difference between "re-fit τ" and "this axis cannot do
// what the tier claims" — and on the human fixture it is the latter.
function precisionCeiling(
  scored: Scored[],
  axisOf: (s: Scored) => number,
  minSupport: number,
): { tau: number; precision: number; support: number } | null {
  let best: { tau: number; precision: number; support: number } | null = null;
  for (const tau of [...new Set(scored.map(axisOf))].sort((a, b) => a - b)) {
    const at = scored.filter((s) => axisOf(s) >= tau);
    if (at.length < minSupport) continue;
    const precision = at.filter((s) => s.label === 'good').length / at.length;
    if (!best || precision > best.precision) best = { tau, precision, support: at.length };
  }
  return best;
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
  const raw = await loadLabels();
  if (raw.length === 0) throw new Error('no labels found in fixtures/eval/labels.jsonl');
  const { labels: corrected, applied } = await applyHumanVerdicts(raw);

  // --human-only fits on hand-labelled pairs ALONE. This is what the pre-registered rule in
  // kappa.ts calls for at κ ≤ 0.30: the model labels do not measure what they claim to, so a τ
  // fitted on them is not a τ. Smaller n, but n of the real thing.
  const humanOnly = process.argv.includes('--human-only');
  const labels = humanOnly ? corrected.filter((l) => l.labeledBy === 'human') : corrected;
  if (labels.length === 0) throw new Error('--human-only: no human-labelled pairs found');
  if (applied > 0) {
    console.log(
      `overlaid ${applied} blind human verdicts (κ=0.160 → the human wins where they land)`,
    );
  }
  if (humanOnly) {
    console.log(
      `--human-only: fitting on ${labels.length} hand-labelled pairs across ${new Set(labels.map((l) => l.beat)).size} beats\n`,
    );
  }

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
  const failedThumbs: string[] = [];
  for (let i = 0; i < thumbPaths.length; i += 64) {
    const batch = thumbPaths.slice(i, i + 64);
    const res = await embedImage(batch);
    batch.forEach((p, j) => {
      if (res.failed.includes(p)) failedThumbs.push(p);
      else thumbByPath.set(p, res.vectors[j] ?? []);
    });
  }
  // A thumb that failed to embed used to be skipped here, read back as [] below, and score
  // cosine([], desc) = 0 — indistinguishable from a real zero. With data/cache evicted (it is an
  // LRU render cache, and labels.jsonl points into it) ALL 222 failed: every base score collapsed
  // to the same 0.266 the quality/orient terms contribute, ROC-AUC came out at exactly 0.500, the
  // bootstrap CIs were zero-width — and the run still printed `precision@1 = 76.7% PASS`. A
  // calibration gate that passes on zero data is worse than one that crashes, so: refuse.
  if (failedThumbs.length > 0) {
    const sample = failedThumbs.slice(0, 3).join('\n    ');
    throw new Error(
      `${failedThumbs.length}/${thumbPaths.length} thumbs failed to embed — every score below would be\n` +
        `  a constant, and every AUC exactly 0.500. Not a result.\n\n` +
        `    ${sample}${failedThumbs.length > 3 ? '\n    …' : ''}\n\n` +
        `  data/cache is a machine-local LRU render cache, so the labeled thumbs are routinely\n` +
        `  evicted. Rebuild them:  pnpm eval:fixtures`,
    );
  }

  const captionSims = await loadCaptionSims();
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
    return {
      ...l,
      sim,
      spec,
      captionSim: captionSims?.get(`${l.beat}|${l.thumbPath}`) ?? null,
      rrf: 0,
      score: baseScore(sim, features, CTX, NOMINAL_BEAT_SEC).base,
    };
  });
  fuseRrf(scored);

  const good = scored.filter((s) => s.label === 'good');
  const bad = scored.filter((s) => s.label === 'bad');
  const tauHi = operatingPoint(scored, (s) => s.score, 0.9, 3);
  const tauHi80 = operatingPoint(scored, (s) => s.score, 0.8, 3);
  const tauLo = operatingPoint(scored, (s) => s.score, 0.7, 3);
  // The ceiling. Reporting only "@90% = n/a" tells you a target was missed but not whether it was
  // missed by 1 point or 20 — and on the 218-human fixture the honest answer is that 90% does not
  // exist on this axis at ANY threshold (max 81.7%). That is a fact about the SCORE, not about the
  // threshold, and no amount of re-fitting produces it. Print it so nobody fits a τ to a target the
  // axis cannot reach and then reports the τ as if it had.
  const ceiling = precisionCeiling(scored, (s) => s.score, 5);
  // The same ceiling for the two candidate axes, because "which axis should the selector use?" is a
  // question about their ceilings and only `score`'s was ever reported. It matters now: on the
  // so400m A/B, raw sim's WITHIN-beat AUC (0.756) beat the base score's (0.713) — the quality/orient
  // terms turned a stronger encoder into a weaker selector (base−sim WITHIN flipped +0.025 → -0.043
  // between base-224 and so400m). Whether dropping them is actually better is a precision question,
  // and this is the line that answers it.
  const ceilingSim = precisionCeiling(scored, (s) => s.sim, 5);
  const ceilingSpec = precisionCeiling(scored, (s) => s.spec, 5);
  // Raw-sim cross-check floor (doc 23 §6): the subject-presence axis, independent of
  // the quality/orient terms that can lift a wrong-but-pretty asset over the base τ.
  const simFloorHi = operatingPoint(scored, (s) => s.sim, 0.9, 3);
  const simFloorLo = operatingPoint(scored, (s) => s.sim, 0.8, 3);
  const simTau80 = operatingPoint(scored, (s) => s.sim, 0.8, 3);
  const specTau80 = operatingPoint(scored, (s) => s.spec, 0.8, 3);

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

  // ---- §3.9: a second, structurally different ranker, fused by RRF ----
  // The premise: SigLIP is near bag-of-words on relations, so "bee on a PURPLE flower" and "bee on
  // an ORANGE flower" collapse toward the same embedding. A caption states the binding in words, and
  // a text encoder can weight it. Fused rather than substituted — RRF needs no shared scale and lets
  // a ranker that is merely uncorrelated still add signal.
  const captioned = scored.filter((s) => s.captionSim != null);
  if (captioned.length === 0) {
    console.log('\n── §3.9 caption ranker: no .caption-sim.json (see services/ml/scripts) ──');
  } else {
    const fullBeats = [...new Set(captioned.map((s) => s.beat))].filter((b) =>
      scored.filter((s) => s.beat === b).every((s) => s.captionSim != null),
    );
    const usable = scored.filter((s) => fullBeats.includes(s.beat));
    console.log('\n── §3.9 caption ranker: cos(bge(desc), bge(florence2 caption)), RRF-fused ──');
    console.log(
      `  coverage           = ${captioned.length}/${scored.length} pairs · ${fullBeats.length} fully-captioned beats (only these are fused)`,
    );
    console.log(`  ROC-AUC raw sim    = ${fmt(rocAuc(usable, (s) => s.sim))}`);
    console.log(
      `  ROC-AUC captionSim = ${fmt(rocAuc(usable, (s) => s.captionSim ?? 0))}   ${verdict(
        rocAuc(usable, (s) => s.sim),
        rocAuc(usable, (s) => s.captionSim ?? 0),
      )}`,
    );
    const wCap = withinBeatAuc(usable, (s) => s.captionSim ?? 0);
    const wRrf = withinBeatAuc(usable, (s) => s.rrf);
    const wSimU = withinBeatAuc(usable, (s) => s.sim);
    console.log(
      `  within-beat AUC    = sim ${wSimU ? wSimU.mean.toFixed(3) : 'n/a'} · caption ${wCap ? wCap.mean.toFixed(3) : 'n/a'} · RRF ${wRrf ? wRrf.mean.toFixed(3) : 'n/a'}`,
    );
    // The pooled ΔAUC for RRF is deliberately absent: RRF scores are per-beat ranks, so pooling them
    // across beats compares numbers that were never on one scale. Reporting it would invite exactly
    // the misreading this harness exists to prevent.
    console.log('  paired tests (the caption axis vs the shipped one, same pairs):');
    console.log(
      `    caption − sim  POOLED = ${call(
        bootstrapDeltaAuc(
          usable,
          (s) => s.sim,
          (s) => s.captionSim ?? 0,
        ),
      )}`,
    );
    console.log(
      `    caption − sim  WITHIN = ${wCall(
        bootstrapWithinBeatDelta(
          usable,
          (s) => s.sim,
          (s) => s.captionSim ?? 0,
        ),
      )}`,
    );
    console.log(
      `    RRF     − sim  WITHIN = ${wCall(
        bootstrapWithinBeatDelta(
          usable,
          (s) => s.sim,
          (s) => s.rrf,
        ),
      )}   ← THE §3.9 DECISION`,
    );
  }

  console.log('\noperating points (base-score space):');
  console.log(`  τ_hi @90% precision = ${fmt(tauHi)}`);
  console.log(`  τ_hi @80% precision = ${fmt(tauHi80)}   ← the shippable tier when @90% is n/a`);
  console.log(`  τ_lo @70% precision = ${fmt(tauLo)}`);
  if (ceiling) {
    const pct = (ceiling.precision * 100).toFixed(1);
    console.log(
      `  CEILING: this axis never exceeds ${pct}% precision (at τ=${ceiling.tau.toFixed(3)}, ${ceiling.support} candidates clear it).`,
    );
    if (tauHi === null) {
      console.log(
        '           So @90% is not a threshold that was missed — it does not exist on this axis.',
      );
      console.log(
        '           Do not fit τ_hi to 90% and report it as such; pick a target the axis reaches.',
      );
    }
  }
  // Which axis should the selector rank on? Compare CEILINGS, not AUCs — AUC is threshold-free and
  // says nothing about the precision you can actually operate at.
  // Coverage at the operating point is half the decision, and reporting a ceiling alone hides it:
  // 87.5% reached by 16 of 218 candidates is not an operating point. A τ that strict sends nearly
  // every beat to the fallback ladder — i.e. to the generic stock the τ exists to avoid. Precision
  // AND how many clear it, or neither number means anything.
  const axisRow = (
    name: string,
    axisOf: (s: Scored) => number,
    c: { tau: number; precision: number; support: number } | null,
    t80: number | null,
  ): string => {
    const ceil = c ? `${(c.precision * 100).toFixed(1)}% (${c.support}/${scored.length})` : 'n/a';
    const at80 =
      t80 === null ? 'n/a' : `${scored.filter((s) => axisOf(s) >= t80).length}/${scored.length}`;
    return `  ${name.padEnd(5)} ceiling ${ceil.padEnd(16)} │ @80%: τ=${fmt(t80).padEnd(6)} clears ${at80}`;
  };
  console.log('\naxis comparison — precision is only half of it; coverage is the other half:');
  console.log(axisRow('score', (s) => s.score, ceiling, tauHi80));
  console.log(axisRow('sim', (s) => s.sim, ceilingSim, simTau80));
  console.log(axisRow('spec', (s) => s.spec, ceilingSpec, specTau80));

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
