import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { type ProcessedBeat, SPLIT_MAX_SEC } from '@scriptreel/core';
import pino from 'pino';
import { OpenAiAnalyzer } from '../analysis/openai-analyzer';
import { runAnalysisWithReprompt } from '../analysis/run-analysis';

// pnpm eval:analyze [G8 G9 …] — run the REAL analyzer over golden scripts and report the
// metrics the prompt is actually accountable for (doc 07 §quality bar). The matching side has
// `eval:matching` against labeled pairs; this is the analyze-side equivalent, and it exists
// because prompt work without measurement is guessing. Costs one brief call + one call per
// chunk per script.
//
// It asserts nothing. Every number below is a judgement call for a human, and the point is to
// see the same numbers before and after a prompt edit rather than to gate CI on a model's mood.

const DEFAULT_SCRIPTS = ['G8', 'G9', 'G10'];

interface Report {
  name: string;
  reconstruction: string;
  language: string;
  musicMood: string;
  beats: ProcessedBeat[];
}

function pct(n: number, of: number): string {
  return of === 0 ? '—' : `${Math.round((n / of) * 100)}%`;
}

function summarize(r: Report): void {
  const { beats } = r;
  const n = beats.length;
  const entityCounts = beats.map((b) => b.entities.length);
  const shotCounts = beats.map((b) => b.shots.length);
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (n === 0 ? 0 : total(xs) / n);

  // The defects the owner reported, as numbers.
  const noEntities = beats.filter((b) => b.entities.length === 0).length;
  const noShots = beats.filter((b) => b.shots.length === 0).length;
  const dupLiteral = beats.filter(
    (b) => new Set(b.queries.literal).size < b.queries.literal.length,
  ).length;
  const oversize = beats.filter((b) => b.estSeconds > SPLIT_MAX_SEC).length;
  // THE defect: a beat that names things and depicts fewer of them. Search resolves shots, not
  // entities, so each of these is an entity that is never sent to an archive. The post-pass
  // (ensureEntityShots) makes this structurally 0 — if it is ever non-zero, that broke.
  const underDepicted = beats.filter(
    (b) => b.shots.length < b.entities.filter((e) => e.visualizable).length,
  ).length;
  // Informational, NOT a defect: the analyzer named one thing, so score's blind-fill montage
  // decides the cadence instead of the shot plan. Fine for a reflective beat, worth a look if
  // it is most of the script.
  const longSingles = beats.filter((b) => b.estSeconds >= 6 && b.shots.length <= 1).length;
  const categories = new Set(beats.flatMap((b) => b.entities.map((e) => e.category)));

  console.log(`\n${'═'.repeat(78)}\n${r.name}  —  ${n} beats  (${r.reconstruction})`);
  console.log(`  language ${r.language} · music ${r.musicMood}`);
  console.log(`  entities   ${total(entityCounts)} total, ${avg(entityCounts).toFixed(1)}/beat`);
  console.log(`  shots      ${total(shotCounts)} total, ${avg(shotCounts).toFixed(1)}/beat`);
  console.log(`  categories ${[...categories].sort().join(', ') || '—'}`);
  console.log('  ── defects (want 0) ──');
  console.log(`  entities with no shot    ${underDepicted}/${n}  ${pct(underDepicted, n)}`);
  console.log(`  beats with NO entities   ${noEntities}/${n}  ${pct(noEntities, n)}`);
  console.log(`  beats with NO shots      ${noShots}/${n}  ${pct(noShots, n)}`);
  console.log(`  duplicate tier-1 queries ${dupLiteral}/${n}  ${pct(dupLiteral, n)}`);
  console.log(`  over the ${SPLIT_MAX_SEC}s split cap    ${oversize}/${n}  ${pct(oversize, n)}`);
  console.log('  ── informational ──');
  console.log(
    `  ≥6s on ≤1 planned shot   ${longSingles}/${n}  ${pct(longSingles, n)}  (blind-fill montage decides these)`,
  );

  console.log('  ── beats ──');
  for (const b of beats) {
    const ents = b.entities.map((e) => `${e.canonical}:${e.category}`).join(' ') || '—';
    console.log(
      `  [${String(b.idx).padStart(2)}] ${b.estSeconds.toFixed(1).padStart(5)}s  ` +
        `${b.shots.length} shots  ${b.entities.length} ents`,
    );
    console.log(`       text  ${b.text.slice(0, 68)}`);
    console.log(`       desc  ${b.visualDescription}`);
    console.log(`       ents  ${ents}`);
    console.log(`       shots ${b.shots.map((s) => `${s.phrase}[${s.want}]`).join(' · ') || '—'}`);
    console.log(`       lit   ${JSON.stringify(b.queries.literal)}`);
  }
}

async function probe(name: string): Promise<Report | null> {
  const path = resolve(rootDir, 'fixtures', 'golden', `${name}.txt`);
  const script = (await readFile(path, 'utf8')).trim();
  const log = pino({ level: 'warn' });
  const analyzer = new OpenAiAnalyzer(log);
  try {
    const { post } = await runAnalysisWithReprompt(analyzer, {
      input: { script, pacing: 'normal' },
      script,
      speed: 1,
    });
    return {
      name,
      reconstruction: post.reconstruction,
      language: post.language,
      musicMood: post.musicMood,
      beats: post.beats,
    };
  } catch (err) {
    console.error(`\n${name}: FAILED — ${String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SCRIPTS;
  for (const name of names) {
    const report = await probe(name);
    if (report) summarize(report);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
