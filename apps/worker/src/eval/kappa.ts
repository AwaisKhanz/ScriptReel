import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { z } from 'zod';

// pnpm eval:kappa — is this fixture's label set valid?
//
// 192 of the 222 labels in fixtures/eval/labels.jsonl were judged by a vision model. Four levers
// (§1.1, §1.2, §1.3, §3.9) were called null against them, τ was calibrated to 0.360 against them,
// and the one significant result (§3.9's caption axis) rests on them. matching.ts already concedes
// an AUC against those labels scores agreement with a model's opinion, not a human's.
//
//   pnpm eval:kappa          → fixtures/eval/kappa.html — 50 pairs, blind, seeded
//   pnpm eval:kappa --score  → confusion matrix + Cohen's κ vs fixtures/eval/kappa-human.jsonl
//
// A model cannot stand in for the human here: the question IS whether model and human agree, so a
// model-labelled sample answers model-vs-model.
//
// PRE-REGISTERED (fixed before any label is collected, so the call cannot drift after the fact):
//   κ ≥ 0.60  → the four nulls stand as evidence; build the §3.9 caption gate.
//   0.30–0.60 → re-run the levers on human labels before writing any of them off.
//   κ ≤ 0.30  → the fixture measures the model's taste; every decision against it, τ=0.360
//               included, is void.
//
// PRELIMINARY, n=30 (2026-07-16): the 30 pre-existing human labels were re-judged blind by two
// independent vision raters. κ(model,human) = +0.416; κ(raterA,raterB) = +1.000. The model is
// perfectly reliable and only moderately valid — not noisy, systematically different. Bias does not
// average out the way noise does. Direction: 8 pairs the model calls bad the human calls good vs 1
// the other way (the model wants literal subject presence; the human accepted thematic fit).
// Lands in the middle band, but n=30 on the servable g1–g3 beats cannot say WHO is right — only
// that the raters mean different things by "good". That is what the 50-pair run settles.
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

// --rest: every model-judged pair NOT already hand-labelled. A different job from sample() above,
// and the difference matters.
//
// sample() draws 25 good / 25 bad to make κ COMPUTABLE (it is undefined when a rater uses one
// class). But that stratification is chosen by the model, and κ = 0.160 says the model is wrong
// ~44% of the time — so the 80 labels fitted in matching.ts are not a random draw from the pool,
// and precision(τ) depends on prevalence. τ = 0.338 is therefore fitted on a class balance picked
// by a broken instrument.
//
// Labelling the REST removes that objection instead of arguing about it: at 222/222 human there is
// no sample, so there is no sampling bias. No stratification here, no target — take everything, in
// beat order, so the rater can work through it like a list rather than a shuffle.
function rest(labels: Label[], alreadyLabelled: Set<string>): Label[] {
  return labels.filter(
    (l) => l.labeledBy === 'model' && !alreadyLabelled.has(`${l.beat}|${l.thumbPath}`),
  );
}

// Blind by construction: the page ships beat + thumb and NOTHING about what the model decided.
// Showing the model's verdict would anchor the rater and manufacture the agreement we are testing.
//
// `storageKey` scopes the autosave so the κ round and the --rest round cannot overwrite each
// other's work. Autosave is not a nicety at 142 pairs: that is a long sitting, and losing it to a
// closed tab would cost real human effort that no model can regenerate.
function html(rows: Label[], opts: { title: string; outFile: string; storageKey: string }): string {
  const data = JSON.stringify(
    rows.map((r) => ({ beat: r.beat, desc: r.beatDescription, thumbPath: r.thumbPath })),
  );
  return `<!doctype html><meta charset="utf-8"><title>ScriptReel — ${opts.title} (${rows.length} pairs)</title>
<style>
 body{font:14px system-ui;margin:24px;max-width:1100px}
 h1{font-size:18px} .hint{background:#f7fafc;border:1px solid #e2e8f0;padding:12px;border-radius:6px}
 figure{display:inline-block;margin:0 10px 16px 0;width:210px;border:3px solid #cbd5e0;border-radius:6px;padding:6px;cursor:pointer;vertical-align:top}
 figure.good{border-color:#38a169} figure.bad{border-color:#e53e3e}
 figure img{width:100%;height:118px;object-fit:cover;border-radius:3px;display:block}
 figcaption{font-size:11px;color:#4a5568;margin-top:4px}
 .q{margin:22px 0 8px;font-weight:600} .q span{font-weight:400;color:#718096}
 .q.done::after{content:' ✓';color:#38a169}
 button{font:13px system-ui;padding:8px 14px;cursor:pointer;margin-right:8px}
 #count{margin-left:4px;color:#4a5568}
 #bar{position:sticky;top:0;background:#fff;padding:10px 0;border-bottom:1px solid #e2e8f0;z-index:9}
 #track{height:6px;background:#e2e8f0;border-radius:3px;margin-top:8px;overflow:hidden}
 #fill{height:100%;width:0;background:#38a169;transition:width .15s}
 #saved{color:#38a169;font-size:12px;margin-left:8px;opacity:0;transition:opacity .3s}
</style>
<h1>${opts.title}</h1>
<div class="hint">
 <p><b>The question for each thumb: does this image actually show what the sentence describes?</b>
 Judge <i>subject presence</i>, not beauty — a gorgeous photo of the wrong thing is <b>bad</b>.
 Judge it the same way every time; a threshold that drifts halfway through is worse than a strict
 one or a lenient one.</p>
 <p>Click a thumb to cycle: unset → <span style="color:#38a169"><b>good</b></span> → <span style="color:#e53e3e"><b>bad</b></span>.
 You are <b>not</b> shown what the model said — that is deliberate, and it is the entire point.</p>
 <p>Your labels <b>autosave in this browser</b>, so you can close the tab and come back.
 When done, click <b>Copy labelled JSONL</b> and save to <code>${opts.outFile}</code>.
 Partial is fine — only what you labelled is exported.</p>
</div>
<div id="bar">
  <button id="copy">Copy labelled JSONL</button>
  <button id="next">Jump to next unlabelled</button>
  <button id="reset">Reset</button>
  <span id="count"></span><span id="saved">saved</span>
  <div id="track"><div id="fill"></div></div>
</div>
<div id="app"></div>
<script>
const ROWS = ${data};
const KEY = ${JSON.stringify(opts.storageKey)};
const state = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  for (const [k, v] of Object.entries(saved)) state.set(k, v);
} catch {}

const app = document.getElementById('app');
const figs = new Map();
const groups = [];
const byDesc = new Map();
for (const r of ROWS) byDesc.set(r.desc, [...(byDesc.get(r.desc) || []), r]);
for (const [desc, rs] of byDesc) {
  const h = document.createElement('div');
  h.className = 'q';
  h.innerHTML = 'Wanted: ' + desc + ' <span>(' + rs.length + ')</span>';
  app.appendChild(h);
  groups.push({ el: h, rows: rs });
  for (const r of rs) {
    const key = r.thumbPath + '|' + r.beat;
    const f = document.createElement('figure');
    f.innerHTML = '<img loading="lazy" src="../../' + r.thumbPath + '"><figcaption>' + r.beat + '</figcaption>';
    f.className = state.get(key) || '';
    f.onclick = () => {
      const cur = state.get(key);
      const next = cur === undefined ? 'good' : cur === 'good' ? 'bad' : undefined;
      if (next) state.set(key, next); else state.delete(key);
      f.className = next || '';
      save(); tick();
    };
    figs.set(key, f);
    app.appendChild(f);
  }
}

let savedTimer;
function save() {
  localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(state)));
  const s = document.getElementById('saved');
  s.style.opacity = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { s.style.opacity = '0'; }, 700);
}
function tick() {
  document.getElementById('count').textContent = state.size + ' / ' + ROWS.length + ' labelled';
  document.getElementById('fill').style.width = (100 * state.size / ROWS.length) + '%';
  for (const g of groups) {
    g.el.classList.toggle('done', g.rows.every(r => state.has(r.thumbPath + '|' + r.beat)));
  }
}
document.getElementById('next').onclick = () => {
  const r = ROWS.find(r => !state.has(r.thumbPath + '|' + r.beat));
  if (!r) { alert('All ' + ROWS.length + ' labelled — click "Copy labelled JSONL".'); return; }
  figs.get(r.thumbPath + '|' + r.beat).scrollIntoView({ behavior: 'smooth', block: 'center' });
};
document.getElementById('reset').onclick = () => {
  if (!confirm('Discard all ' + state.size + ' labels on this page?')) return;
  state.clear(); localStorage.removeItem(KEY);
  for (const f of figs.values()) f.className = '';
  tick();
};
document.getElementById('copy').onclick = async () => {
  const out = ROWS.filter(r => state.has(r.thumbPath + '|' + r.beat))
    .map(r => JSON.stringify({ beat: r.beat, thumbPath: r.thumbPath, human: state.get(r.thumbPath + '|' + r.beat) }))
    .join('\\n');
  await navigator.clipboard.writeText(out + '\\n');
  document.getElementById('copy').textContent = 'Copied ' + state.size + ' → paste into ${opts.outFile}';
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

  // --rest: build the labelling page for everything still model-judged. Turns the fixture into
  // 222/222 human ground truth, which is the only way to retire the prevalence objection against
  // τ (see rest() above). Writes its own file so kappa-human.jsonl — 50 labels that cost real
  // time — is never at risk of being clobbered by a page reload.
  if (process.argv.includes('--rest')) {
    const humanPath = resolve(rootDir, 'fixtures/eval/kappa-human.jsonl');
    const done = existsSync(humanPath)
      ? new Set(
          (await loadJsonl('fixtures/eval/kappa-human.jsonl', HumanSchema)).map(
            (h) => `${h.beat}|${h.thumbPath}`,
          ),
        )
      : new Set<string>();
    const rows = rest(labels, done);
    if (rows.length === 0) {
      console.log('=== eval:kappa --rest — nothing left ===\n');
      console.log('  Every model-judged pair already has a human label. The fixture is fully');
      console.log('  hand-labelled; run  pnpm eval:matching --human-only  to fit on all of it.');
      return;
    }
    await writeFile(
      resolve(rootDir, 'fixtures/eval/kappa-rest.html'),
      html(rows, {
        title: 'Label the rest — turning the fixture into real ground truth',
        outFile: 'fixtures/eval/kappa-rest.jsonl',
        storageKey: 'scriptreel.kappa.rest.v1',
      }),
      'utf8',
    );
    const good = rows.filter((r) => r.label === 'good').length;
    console.log('=== eval:kappa --rest — labelling page built ===');
    console.log(`  ${rows.length} pairs across ${new Set(rows.map((r) => r.beat)).size} beats`);
    console.log(`  (${done.size} already labelled in kappa-human.jsonl — excluded, not re-asked)`);
    console.log(`  model says: ${good} good / ${rows.length - good} bad  (hidden from the page)\n`);
    console.log('  1. open   fixtures/eval/kappa-rest.html');
    console.log('  2. click each thumb: unset → good → bad. Labels autosave; you can stop and');
    console.log('     resume, and partial output is fine.');
    console.log('  3. "Copy labelled JSONL" → save to  fixtures/eval/kappa-rest.jsonl');
    console.log('  4. run  pnpm eval:matching --human-only\n');
    console.log('  Why: the 50 κ labels were stratified 25/25 BY THE MODEL, and κ=0.160 says the');
    console.log('  model is wrong ~44% of the time — so τ=0.338 is fitted on a class balance');
    console.log('  chosen by a broken instrument. At 222/222 human there is no sample, so there');
    console.log('  is no sampling bias left to argue about.');
    return;
  }

  if (!process.argv.includes('--score')) {
    const rows = sample(labels);
    const good = rows.filter((r) => r.label === 'good').length;
    await writeFile(
      resolve(rootDir, 'fixtures/eval/kappa-sample.jsonl'),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      resolve(rootDir, 'fixtures/eval/kappa.html'),
      html(rows, {
        title: "κ sample — does the vision model's judgement match yours?",
        outFile: 'fixtures/eval/kappa-human.jsonl',
        storageKey: 'scriptreel.kappa.sample.v1',
      }),
      'utf8',
    );
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

  // --score before the labelling is done is the obvious mistake to make (the two commands sit next
  // to each other in the build output, and the work between them happens in a browser). Say so, and
  // say what to do — an ENOENT stack trace for a file the user was never told to create by hand
  // reads like a broken tool rather than a missing step.
  const humanPath = resolve(rootDir, 'fixtures/eval/kappa-human.jsonl');
  if (!existsSync(humanPath)) {
    console.log('=== eval:kappa --score — nothing to score yet ===\n');
    console.log('  fixtures/eval/kappa-human.jsonl does not exist, so the labels have not been');
    console.log("  collected. --score compares YOUR verdicts against the model's; there is no");
    console.log(
      '  shortcut, and a model cannot stand in for you here (that is the whole question).\n',
    );
    console.log('  1. open   fixtures/eval/kappa.html   in a browser');
    console.log('     (missing? run `pnpm eval:kappa` to rebuild it — same 50 pairs, fixed seed)');
    console.log('  2. click each thumb: unset → good → bad. All 50.');
    console.log('  3. click "Copy labelled JSONL", paste into  fixtures/eval/kappa-human.jsonl');
    console.log('  4. run  pnpm eval:kappa --score\n');
    console.log('  ~20 minutes. It decides whether τ = 0.360 and the four measured nulls stand.');
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
  // Both directions. This check used to fire only when the model was too LENIENT — so on the
  // n=50 run it stayed silent about the dominant feature of the matrix (16 model-bad/human-good
  // vs 5 the other way). The two biases are not symmetric in consequence and each needs saying.
  if (modelGoodHumanBad > modelBadHumanGood * 2) {
    console.log(
      `\n  ⚠ asymmetry: the model calls ${modelGoodHumanBad} pairs good that you call bad, vs ${modelBadHumanGood} the other way.`,
    );
    console.log(
      '    A model biased toward "good" INFLATES precision at every τ, so the fitted τ is too LOW',
    );
    console.log('    and the selector ships candidates you would reject.');
  } else if (modelBadHumanGood > modelGoodHumanBad * 2) {
    console.log(
      `\n  ⚠ asymmetry: the model calls ${modelBadHumanGood} pairs BAD that you call GOOD, vs ${modelGoodHumanBad} the other way.`,
    );
    console.log(
      '    Those are phantom false-positives at every threshold: precision(τ) counts them against',
    );
    console.log(
      '    a τ that in truth cleared them, so measured precision reads LOW and the fit climbs to',
    );
    console.log(
      '    compensate. The fitted τ is too HIGH — the selector rejects candidates you would accept,',
    );
    console.log('    dropping those beats to the fallback ladder and generic stock.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
