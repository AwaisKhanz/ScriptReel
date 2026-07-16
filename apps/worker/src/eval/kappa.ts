import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { z } from 'zod';

// pnpm eval:kappa — measure whether this fixture's MODEL labels track a HUMAN.
//
// Why this exists, and why it outranks every remaining idea in the redesign plan:
// 192 of the 222 labels in fixtures/eval/labels.jsonl were judged by a vision model. Four levers
// (§1.1 contrastive, §1.2 score terms, §1.3 SO400M, §3.9 caption+RRF) were declared null against
// that instrument, τ was re-calibrated against it, and the one significant result yet found (the
// §3.9 caption axis, pooled ΔAUC +0.076) rests on it too. If the model labels track a human, all of
// that stands. If they don't, EVERY ONE of those decisions is an artifact and must be re-run.
// Nobody has ever checked. That is a five-decision swing for an afternoon of clicking.
//
// This is the one measurement an AI cannot perform for you. The question IS "does a model agree
// with a human" — so a model labelling the sample answers a different question (model vs model),
// which is exactly the doubt we are trying to remove. Circularity is the whole hazard here.
//
//   pnpm eval:kappa            → writes fixtures/eval/kappa.html (blind) + kappa-sample.jsonl
//   pnpm eval:kappa --score    → reads fixtures/eval/kappa-human.jsonl, reports κ and the verdict
//
// PRE-REGISTERED — decided BEFORE any label is collected, so the result cannot be rationalised
// after the fact (the failure that produced the phantom §1.1 +0.040 at n=30):
//   κ ≥ 0.60  → substantial agreement. The four nulls STAND as real evidence, the plan is finished
//               as a quality program, and the §3.9 caption-gate finding is worth building.
//   0.30–0.60 → moderate/fair. The instrument is too noisy to have DECLARED those nulls; effects
//               smaller than the noise floor were unresolvable. Re-run the levers on human labels.
//   κ ≤ 0.30  → poor. The fixture measures the vision model's taste, not quality. Every decision
//               taken against it — including τ = 0.360 — is void and must be re-derived.
const SAMPLE_TARGET = 50;

const LabelSchema = z.object({
  beat: z.string(),
  beatDescription: z.string(),
  thumbPath: z.string(),
  label: z.enum(['good', 'bad']),
  labeledBy: z.enum(['human', 'model']).optional(),
});
type Label = z.infer<typeof LabelSchema>;

const HumanSchema = z.object({
  beat: z.string(),
  thumbPath: z.string(),
  human: z.enum(['good', 'bad']),
});

async function loadJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const raw = await readFile(resolve(rootDir, path), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => schema.parse(JSON.parse(l)));
}

// Deterministic PRNG (xorshift32) — the same generator the bootstrap in matching.ts uses. A fixed
// seed matters here: the sample must be reproducible, or "which 50" becomes a free parameter
// someone could re-roll until the answer flatters the fixture.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const ai = a[i] as T;
    a[i] = a[j] as T;
    a[j] = ai;
  }
  return a;
}

// Stratified over (beat × label). A naive random 50 would over-weight the beats that happen to have
// the most candidates and could return an all-'bad' draw — κ is undefined when a rater uses one
// class only, so balance is a correctness requirement, not a nicety.
function sample(labels: Label[]): Label[] {
  const rand = rng(0x5eed_1234);
  const pool = labels.filter((l) => l.labeledBy === 'model');
  const picked: Label[] = [];
  for (const want of ['good', 'bad'] as const) {
    const byBeat = new Map<string, Label[]>();
    for (const l of pool.filter((p) => p.label === want)) {
      byBeat.set(l.beat, [...(byBeat.get(l.beat) ?? []), l]);
    }
    // Round-robin across beats so no single beat dominates the stratum.
    const queues = [...byBeat.values()].map((v) => shuffled(v, rand));
    const target = Math.floor(SAMPLE_TARGET / 2);
    let added = 0;
    for (let depth = 0; added < target; depth++) {
      let progressed = false;
      for (const q of queues) {
        const item = q[depth];
        if (!item) continue;
        picked.push(item);
        progressed = true;
        if (++added >= target) break;
      }
      if (!progressed) break; // stratum exhausted
    }
  }
  return shuffled(picked, rand); // interleave good/bad so the order leaks nothing
}

// Blind by construction: the page ships beat + thumb and NOTHING about what the model decided.
// Showing the model's verdict would anchor the rater and manufacture the agreement we are testing.
function html(rows: Label[]): string {
  const data = JSON.stringify(
    rows.map((r) => ({ beat: r.beat, desc: r.beatDescription, thumbPath: r.thumbPath })),
  );
  return `<!doctype html><meta charset="utf-8"><title>ScriptReel — κ sample (${rows.length} pairs)</title>
<style>
 body{font:14px system-ui;margin:24px;max-width:1100px}
 h1{font-size:18px} .hint{background:#f7fafc;border:1px solid #e2e8f0;padding:12px;border-radius:6px}
 figure{display:inline-block;margin:0 10px 16px 0;width:210px;border:3px solid #cbd5e0;border-radius:6px;padding:6px;cursor:pointer;vertical-align:top}
 figure.good{border-color:#38a169} figure.bad{border-color:#e53e3e}
 figure img{width:100%;height:118px;object-fit:cover;border-radius:3px;display:block}
 figcaption{font-size:11px;color:#4a5568;margin-top:4px}
 .q{margin:22px 0 8px;font-weight:600} .q span{font-weight:400;color:#718096}
 button{font:13px system-ui;padding:8px 14px;cursor:pointer} #count{margin-left:10px;color:#4a5568}
 #bar{position:sticky;top:0;background:#fff;padding:10px 0;border-bottom:1px solid #e2e8f0;z-index:9}
</style>
<h1>κ sample — does the vision model's judgement match yours?</h1>
<div class="hint">
 <p><b>The question for each thumb: does this image actually show what the sentence describes?</b>
 Judge <i>subject presence</i>, not beauty — a gorgeous photo of the wrong thing is <b>bad</b>.</p>
 <p>Click a thumb to cycle: unset → <span style="color:#38a169"><b>good</b></span> → <span style="color:#e53e3e"><b>bad</b></span>.
 You are <b>not</b> shown what the model said — that is deliberate, and it is the entire point.
 Label all ${rows.length}, then copy and save to <code>fixtures/eval/kappa-human.jsonl</code>.</p>
</div>
<div id="bar"><button id="copy">Copy labelled JSONL</button><span id="count"></span></div>
<div id="app"></div>
<script>
const ROWS = ${data};
const state = new Map();
const app = document.getElementById('app');
const byDesc = new Map();
for (const r of ROWS) byDesc.set(r.desc, [...(byDesc.get(r.desc) || []), r]);
for (const [desc, rs] of byDesc) {
  const h = document.createElement('div');
  h.className = 'q';
  h.innerHTML = 'Wanted: ' + desc + ' <span>(' + rs.length + ')</span>';
  app.appendChild(h);
  for (const r of rs) {
    const f = document.createElement('figure');
    f.innerHTML = '<img loading="lazy" src="../../' + r.thumbPath + '"><figcaption>' + r.beat + '</figcaption>';
    f.onclick = () => {
      const cur = state.get(r.thumbPath + '|' + r.beat);
      const next = cur === undefined ? 'good' : cur === 'good' ? 'bad' : undefined;
      if (next) state.set(r.thumbPath + '|' + r.beat, next); else state.delete(r.thumbPath + '|' + r.beat);
      f.className = next || '';
      tick();
    };
    app.appendChild(f);
  }
}
function tick() {
  document.getElementById('count').textContent = state.size + ' / ' + ROWS.length + ' labelled';
}
document.getElementById('copy').onclick = async () => {
  const out = ROWS.filter(r => state.has(r.thumbPath + '|' + r.beat))
    .map(r => JSON.stringify({ beat: r.beat, thumbPath: r.thumbPath, human: state.get(r.thumbPath + '|' + r.beat) }))
    .join('\\n');
  await navigator.clipboard.writeText(out + '\\n');
  document.getElementById('copy').textContent = 'Copied ' + state.size + ' → paste into fixtures/eval/kappa-human.jsonl';
};
tick();
</script>`;
}

// Cohen's κ — agreement CORRECTED for the agreement two raters would reach by chance alone. Raw
// agreement is the number that flatters: on a 60/40 split two raters who never look at the images
// agree ~52% of the time, which reads as "mostly agree" and means nothing.
function cohensKappa(pairs: { a: string; b: string }[]): {
  kappa: number;
  po: number;
  pe: number;
} {
  const n = pairs.length;
  const po = pairs.filter((p) => p.a === p.b).length / n;
  let pe = 0;
  for (const cls of ['good', 'bad']) {
    pe +=
      (pairs.filter((p) => p.a === cls).length / n) * (pairs.filter((p) => p.b === cls).length / n);
  }
  return { kappa: (po - pe) / (1 - pe), po, pe };
}

async function main(): Promise<void> {
  const labels = await loadJsonl('fixtures/eval/labels.jsonl', LabelSchema);

  if (!process.argv.includes('--score')) {
    const rows = sample(labels);
    const good = rows.filter((r) => r.label === 'good').length;
    await writeFile(
      resolve(rootDir, 'fixtures/eval/kappa-sample.jsonl'),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
      'utf8',
    );
    await writeFile(resolve(rootDir, 'fixtures/eval/kappa.html'), html(rows), 'utf8');
    console.log(`=== eval:kappa — sample built ===`);
    console.log(
      `  ${rows.length} pairs drawn from the ${labels.filter((l) => l.labeledBy === 'model').length} model-judged`,
    );
    console.log(`  model says: ${good} good / ${rows.length - good} bad  (hidden from the page)`);
    console.log(`  beats covered: ${new Set(rows.map((r) => r.beat)).size}`);
    console.log(`\n  1. open  fixtures/eval/kappa.html`);
    console.log(`  2. label all ${rows.length}, click "Copy labelled JSONL"`);
    console.log(`  3. save to  fixtures/eval/kappa-human.jsonl`);
    console.log(`  4. run  pnpm eval:kappa --score`);
    return;
  }

  const human = await loadJsonl('fixtures/eval/kappa-human.jsonl', HumanSchema);
  const byKey = new Map<string, Label>();
  for (const l of labels) byKey.set(`${l.beat}|${l.thumbPath}`, l);
  // Join on (beat, thumbPath). A human row with no match is dropped rather than guessed at — the
  // whole point is comparing the two raters on the SAME pairs.
  const pairs: { a: string; b: string }[] = [];
  for (const h of human) {
    const model = byKey.get(`${h.beat}|${h.thumbPath}`);
    if (model) pairs.push({ a: model.label, b: h.human });
  }
  if (pairs.length === 0) throw new Error('no human labels joined against labels.jsonl');
  if (pairs.length < human.length) {
    console.log(`⚠ ${human.length - pairs.length} human rows did not join and were dropped\n`);
  }

  const { kappa, po, pe } = cohensKappa(pairs);
  const bothGood = pairs.filter((p) => p.a === 'good' && p.b === 'good').length;
  const bothBad = pairs.filter((p) => p.a === 'bad' && p.b === 'bad').length;
  const modelGoodHumanBad = pairs.filter((p) => p.a === 'good' && p.b === 'bad').length;
  const modelBadHumanGood = pairs.filter((p) => p.a === 'bad' && p.b === 'good').length;

  console.log('=== eval:kappa --score ===');
  console.log(`joined ${pairs.length} model↔human pairs\n`);
  console.log('confusion (rows = model, cols = human):');
  console.log('                human good   human bad');
  console.log(
    `  model good   ${String(bothGood).padStart(9)}   ${String(modelGoodHumanBad).padStart(9)}`,
  );
  console.log(
    `  model bad    ${String(modelBadHumanGood).padStart(9)}   ${String(bothBad).padStart(9)}`,
  );
  console.log(`\n  raw agreement  p_o = ${po.toFixed(3)}   (the flattering number)`);
  console.log(`  chance         p_e = ${pe.toFixed(3)}   (what two blind raters would hit)`);
  console.log(`  Cohen's κ          = ${kappa.toFixed(3)}`);
  // Pre-registered above — printed verbatim so the call cannot drift after seeing the number.
  const verdict =
    kappa >= 0.6
      ? 'κ ≥ 0.60 → SUBSTANTIAL. The four nulls stand as real evidence; the §3.9 caption-gate finding is worth building.'
      : kappa > 0.3
        ? 'κ in (0.30, 0.60) → MODERATE/FAIR. Too noisy to have DECLARED those nulls — re-run the levers on human labels.'
        : "κ ≤ 0.30 → POOR. The fixture measures the model's taste. Every decision taken against it, τ = 0.360 included, is void.";
  console.log(`\n  PRE-REGISTERED VERDICT: ${verdict}`);
  if (modelGoodHumanBad > modelBadHumanGood * 2) {
    console.log(
      `\n  ⚠ asymmetry: the model calls ${modelGoodHumanBad} pairs good that you call bad, vs ${modelBadHumanGood} the other way.`,
    );
    console.log(
      '    A model biased toward "good" inflates precision at every τ — the exact defect R1 names.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
