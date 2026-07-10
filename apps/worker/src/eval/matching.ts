import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { baseScore, type CandidateFeatures, cosine, type ScoreContext } from '@scriptreel/core';
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

// Precision-at-threshold curve: precision(τ) = #good with score≥τ / #all with score≥τ.
// τ_hi = lowest τ reaching 90% precision, τ_lo = 70% (doc 09 §step 3, doc 21).
function operatingPoint(
  scored: Scored[],
  targetPrecision: number,
  minSupport: number,
): number | null {
  const thresholds = [...new Set(scored.map((s) => s.score))].sort((a, b) => a - b);
  for (const tau of thresholds) {
    const at = scored.filter((s) => s.score >= tau);
    if (at.length < minSupport) continue;
    const precision = at.filter((s) => s.label === 'good').length / at.length;
    if (precision >= targetPrecision) return tau;
  }
  return null;
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
    const features: CandidateFeatures = {
      kind: l.kind,
      isIllustration: false,
      width: l.width,
      height: l.height,
      durationSec: l.duration,
      fps: null,
    };
    return { ...l, sim, score: baseScore(sim, features, CTX, NOMINAL_BEAT_SEC).base };
  });

  const good = scored.filter((s) => s.label === 'good');
  const bad = scored.filter((s) => s.label === 'bad');
  const tauHi = operatingPoint(scored, 0.9, 3);
  const tauLo = operatingPoint(scored, 0.7, 3);

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
  console.log('\nscore histogram (✓=good ░=bad):');
  console.log(histogram(scored));
  console.log('\noperating points (base-score space):');
  console.log(`  τ_hi @90% precision = ${fmt(tauHi)}`);
  console.log(`  τ_lo @70% precision = ${fmt(tauLo)}`);
  console.log('\nper-beat top-1:');
  console.log(perBeat.join('\n'));
  console.log(
    `\nprecision@1 (top-1 acceptance) = ${(precisionAt1 * 100).toFixed(1)}%  (gate ≥55%: ${precisionAt1 >= 0.55 ? 'PASS' : 'FAIL'})`,
  );
  await db.closeDb();
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const min = (xs: number[]): number => (xs.length ? Math.min(...xs) : 0);
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);
const fmt = (x: number | null): string => (x == null ? 'n/a (never reaches target)' : x.toFixed(3));

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
