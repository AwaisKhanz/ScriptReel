import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import type { RawCandidate, RequestAuth } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pLimit from 'p-limit';
import { z } from 'zod';
import { PexelsProvider } from '../providers/pexels';
import { ensureThumb } from '../providers/thumbs';

// pnpm eval:pool — grow the labelling set behind `pnpm eval:matching`.
//
// Why this exists: the fixture is 30 pairs over 6 beats, and every beat contains a good
// candidate. That is too small to decide anything (the AUC standard error is ~0.095, wider than
// the +0.040 that contrastive normalisation showed), and with no all-bad beat the abstain path —
// exactly what the §1.1 accept rule redefines — is never exercised, so precision@1 sits pinned at
// 100% and cannot see a calibration change at all.
//
// Reads fixtures/eval/pool-spec.jsonl (beat + description + generic stock query), searches the
// REAL provider, and materialises thumbs through the REAL thumb path (providers/thumbs.ts), so
// pooled thumbs are byte-identical to what the pipeline would score. Emits:
//   fixtures/eval/pool.jsonl — rows in labels.jsonl shape with "label": null
//   fixtures/eval/label.html — a self-contained page to click good/bad and copy the JSONL back
//
// Idempotent: beats already present in labels.jsonl are skipped, so re-running never disturbs
// work you've already labelled and never re-spends quota on them.

const SpecSchema = z.object({
  beat: z.string(),
  beatDescription: z.string(),
  query: z.string(),
  kind: z.enum(['video', 'image']),
  expect: z.enum(['servable', 'hard']).optional(), // documentation only — never read by the tool
});
type Spec = z.infer<typeof SpecSchema>;

// A pool row is a labels.jsonl row with the verdict still open.
interface PoolRow {
  beat: string;
  beatDescription: string;
  thumbPath: string;
  kind: 'video' | 'image';
  width: number;
  height: number;
  duration: number | null;
  label: null;
}

const CANDIDATES_PER_BEAT = 8; // 24 beats x 8 ~= 190 new pairs — past the noise floor
const BEAT_PARALLELISM = 2; // Pexels is 200 req/h; stay far below it (doc 06: bounded, never unbounded)
const THUMB_PARALLELISM = 4;

function parseJsonl<T>(raw: string, schema: z.ZodType<T>, what: string): T[] {
  const out: T[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const l = line.trim();
    if (!l || l.startsWith('//')) continue;
    const parsed = schema.safeParse(JSON.parse(l));
    if (!parsed.success) throw new Error(`${what} line ${i + 1}: ${parsed.error.message}`);
    out.push(parsed.data);
  }
  return out;
}

// labels.jsonl stores repo-relative POSIX paths; normalise so Windows backslashes never leak in.
function toRepoPath(abs: string): string {
  return relative(rootDir, abs).split('\\').join('/');
}

async function labelledBeats(): Promise<Set<string>> {
  try {
    const raw = await readFile(resolve(rootDir, 'fixtures/eval/labels.jsonl'), 'utf8');
    const rows = parseJsonl(raw, z.object({ beat: z.string() }), 'labels.jsonl');
    return new Set(rows.map((r) => r.beat));
  } catch {
    return new Set(); // no labels yet — everything is new
  }
}

async function poolForBeat(
  spec: Spec,
  provider: PexelsProvider,
  auth: RequestAuth,
): Promise<PoolRow[]> {
  const found: RawCandidate[] = await provider.search(
    {
      query: spec.query,
      kind: spec.kind,
      orientation: 'landscape', // matches the eval's 16:9 ScoreContext
      perPage: CANDIDATES_PER_BEAT,
    },
    auth,
  );
  const limit = pLimit(THUMB_PARALLELISM);
  const signal = AbortSignal.timeout(120_000);
  const rows = await Promise.all(
    found.slice(0, CANDIDATES_PER_BEAT).map((c) =>
      limit(async (): Promise<PoolRow | null> => {
        const thumb = await ensureThumb(c, signal);
        if (!thumb) return null; // no thumb ⇒ nothing to score ⇒ nothing to label
        return {
          beat: spec.beat,
          beatDescription: spec.beatDescription,
          thumbPath: toRepoPath(thumb),
          kind: spec.kind,
          width: c.width ?? 0,
          height: c.height ?? 0,
          duration: c.duration ?? null,
          label: null,
        };
      }),
    ),
  );
  return rows.filter((r): r is PoolRow => r !== null);
}

function labelHtml(rows: PoolRow[]): string {
  // Self-contained: opened over file://, thumbPaths resolve relative to fixtures/eval/.
  const byBeat = new Map<string, PoolRow[]>();
  for (const r of rows) byBeat.set(r.beat, [...(byBeat.get(r.beat) ?? []), r]);
  const data = JSON.stringify(
    [...byBeat.entries()].map(([beat, rs]) => ({
      beat,
      description: rs[0]?.beatDescription ?? '',
      items: rs.map((r) => ({ thumbPath: r.thumbPath, src: `../../${r.thumbPath}` })),
    })),
  );
  return `<!doctype html>
<meta charset="utf-8"><title>ScriptReel — label eval pool</title>
<style>
 body{font:14px system-ui;margin:24px;background:#111;color:#eee}
 h2{font-size:15px;margin:24px 0 4px}
 .desc{color:#9ae6b4;margin-bottom:8px}
 .grid{display:flex;flex-wrap:wrap;gap:8px}
 figure{margin:0;cursor:pointer;border:3px solid #444;border-radius:6px;overflow:hidden;width:190px}
 figure img{display:block;width:190px;height:107px;object-fit:cover}
 figure.good{border-color:#38a169} figure.bad{border-color:#e53e3e}
 figcaption{font-size:11px;padding:3px 5px;color:#aaa}
 #bar{position:sticky;top:0;background:#111;padding:10px 0;border-bottom:1px solid #333;z-index:1}
 button{font:13px system-ui;padding:7px 12px;margin-right:8px;cursor:pointer}
 #out{width:100%;height:130px;margin-top:8px;font:11px monospace}
</style>
<div id="bar">
  <b>Click a thumb to cycle:</b> unset → <span style="color:#38a169">good</span> → <span style="color:#e53e3e">bad</span>.
  A beat where nothing fits should be marked <b>all bad</b> — that is the point.
  <button id="copy">Copy labelled JSONL</button><span id="count"></span>
  <textarea id="out" readonly placeholder="labelled rows appear here — paste them into fixtures/eval/labels.jsonl"></textarea>
</div>
<div id="app"></div>
<script>
const DATA = ${data};
const state = new Map(); // thumbPath -> 'good' | 'bad'
const app = document.getElementById('app');
for (const b of DATA) {
  const h = document.createElement('h2'); h.textContent = b.beat; app.append(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = b.description; app.append(d);
  const g = document.createElement('div'); g.className = 'grid'; app.append(g);
  for (const it of b.items) {
    const f = document.createElement('figure');
    const im = document.createElement('img'); im.src = it.src; im.loading = 'lazy';
    const c = document.createElement('figcaption'); c.textContent = it.thumbPath.split('/').pop();
    f.append(im, c); g.append(f);
    f.onclick = () => {
      const cur = state.get(it.thumbPath);
      const next = cur === undefined ? 'good' : cur === 'good' ? 'bad' : undefined;
      if (next) state.set(it.thumbPath, next); else state.delete(it.thumbPath);
      f.className = next ?? '';
      render();
    };
  }
}
function render() {
  const rows = DATA.flatMap(b => b.items.filter(i => state.has(i.thumbPath)).map(i =>
    JSON.stringify({ beat: b.beat, beatDescription: b.description, thumbPath: i.thumbPath,
      ...META[i.thumbPath], label: state.get(i.thumbPath) })));
  document.getElementById('out').value = rows.join('\\n');
  const total = DATA.reduce((a,b)=>a+b.items.length,0);
  document.getElementById('count').textContent = \`  \${state.size} / \${total} labelled\`;
}
const META = ${JSON.stringify(
    Object.fromEntries(
      rows.map((r) => [
        r.thumbPath,
        { kind: r.kind, width: r.width, height: r.height, duration: r.duration },
      ]),
    ),
  )};
document.getElementById('copy').onclick = () => {
  const t = document.getElementById('out'); t.select(); navigator.clipboard.writeText(t.value);
};
render();
</script>`;
}

async function main(): Promise<void> {
  const specRaw = await readFile(resolve(rootDir, 'fixtures/eval/pool-spec.jsonl'), 'utf8');
  const specs = parseJsonl(specRaw, SpecSchema, 'pool-spec.jsonl');
  const done = await labelledBeats();
  const todo = specs.filter((s) => !done.has(s.beat));
  console.log(
    `specs: ${specs.length} · already labelled: ${specs.length - todo.length} · to build: ${todo.length}`,
  );
  if (todo.length === 0) {
    console.log('nothing to do — every spec beat is already in labels.jsonl.');
    await db.closeDb();
    return;
  }

  // Keys live in provider_keys (the Settings UI), not .env — resolve them as the pipeline does.
  const keys = await db.activeKeysFor('pexels');
  const apiKey = keys[0]?.creds.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('no active pexels API key — add one in Settings, then re-run');
  }
  const auth: RequestAuth = { kind: 'header', name: 'Authorization', value: apiKey };
  const provider = new PexelsProvider();

  const limit = pLimit(BEAT_PARALLELISM);
  const perBeat = await Promise.all(
    todo.map((spec) =>
      limit(async () => {
        try {
          const rows = await poolForBeat(spec, provider, auth);
          console.log(
            `  ${spec.beat.padEnd(4)} ${String(rows.length).padStart(2)} candidates  "${spec.query}"`,
          );
          return rows;
        } catch (err) {
          console.log(
            `  ${spec.beat.padEnd(4)} FAILED — ${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as PoolRow[];
        }
      }),
    ),
  );
  const rows = perBeat.flat();
  if (rows.length === 0) throw new Error('no candidates pooled — nothing to label');

  const poolPath = resolve(rootDir, 'fixtures/eval/pool.jsonl');
  const htmlPath = resolve(rootDir, 'fixtures/eval/label.html');
  await writeFile(poolPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  await writeFile(htmlPath, labelHtml(rows), 'utf8');

  console.log(`\npooled ${rows.length} candidates over ${todo.length} beats`);
  console.log(`  ${toRepoPath(poolPath)}   (unlabelled rows)`);
  console.log(
    `  ${toRepoPath(htmlPath)}   ← open this, click good/bad, copy into fixtures/eval/labels.jsonl`,
  );
  console.log('then: pnpm eval:matching');
  await db.closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
