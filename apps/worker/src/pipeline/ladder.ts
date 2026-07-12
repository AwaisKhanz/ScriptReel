import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  baseScore,
  broadenQuery,
  cosine,
  matchesOrientation,
  orientationForAspect,
  PER_PAGE_PHOTO,
  PER_PAGE_VIDEO,
  type PlannedRequest,
  passesHygiene,
  type RawCandidate,
  type Rung,
  type ScoreContext,
  type SelectionCandidate,
  type SubtitleAspect,
  TAU_HI,
  TAU_LO,
  TAU_MOOD,
  targetHeightForAspect,
  themeForEmotion,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pLimit from 'p-limit';
import { generateImage } from '../generate/flux';
import type { SearchClient } from '../providers/search';
import { ensureThumb } from '../providers/thumbs';
import { embedImage, embedText, renderTextcard } from '../sidecar/client';
import type { ProjectCtx } from './context';

const THUMB_PARALLELISM = 4;
const LADDER_ADD_CAP = 20; // per rung, keep the candidate explosion bounded

const TARGET_DIMS: Record<string, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};

// Generation canvas per aspect (doc 25 §5-E, Rung 4). Smaller than the final render dims —
// FLUX is slow and the still is upscaled/normalized at fetch anyway; all are multiples of 16.
const GEN_DIMS: Record<string, [number, number]> = {
  '16:9': [1024, 576],
  '9:16': [576, 1024],
  '1:1': [768, 768],
};

export interface LadderBeat {
  id: string;
  idx: number;
  keyPhrase: string;
  emotion: string;
  aspect: SubtitleAspect;
  descEmbedding: number[];
  literal0: string;
  conceptual: string;
  mood: string;
  beatDurationSec: number;
  existing: readonly SelectionCandidate[]; // tier-1 candidates, already scored vs the description
  forcedTextcard: boolean;
  // Rung 4 generative fallback (doc 25 §5-E): true ⇒ an abstract beat with NO visualizable
  // named entity, so a generated image can't fabricate a real subject. Entity beats are
  // false and skip generation entirely, dropping straight to the text card.
  nonEntity: boolean;
  // The beat's rich visual description — used verbatim as the generation prompt (falls back
  // to conceptual / keyPhrase when empty).
  visualDescription: string;
}

export interface LadderDeps {
  ctx: ProjectCtx;
  scoreCtx: ScoreContext;
  client: SearchClient;
  chosenAssetKeys: Set<string>; // assets chosen by earlier beats — avoid reuse
}

export interface LadderResult {
  chosenId: string;
  chosenAssetKey: string;
  rung: Rung;
  weak: boolean;
  ranked: { id: string; score: number; rank: number }[];
}

function keysOf(pool: readonly SelectionCandidate[]): Set<string> {
  return new Set(pool.map((c) => c.assetKey));
}

function bothProviders(query: string): PlannedRequest[] {
  return [
    { provider: 'pexels', kind: 'video', query },
    { provider: 'pixabay', kind: 'video', query },
    { provider: 'pixabay', kind: 'image', query },
  ];
}

// Fire a rung's searches, ingest new candidates (hygiene → dedupe → thumb → persist),
// embed them, and score sim against `anchor` (the description, or a mood text).
async function fireRung(
  beat: LadderBeat,
  requests: PlannedRequest[],
  anchor: number[],
  deps: LadderDeps,
  existingKeys: Set<string>,
): Promise<SelectionCandidate[]> {
  const { ctx } = deps;
  const orientation = orientationForAspect(beat.aspect);
  const targetHeight = targetHeightForAspect(beat.aspect);

  const raw: RawCandidate[] = [];
  for (const r of requests) {
    if (!r.query) continue;
    if (ctx.signal.aborted) return [];
    const perPage = r.kind === 'video' ? PER_PAGE_VIDEO : PER_PAGE_PHOTO;
    const res = await deps.client.search(
      { query: r.query, kind: r.kind, orientation, perPage },
      r.provider,
    );
    raw.push(...res.candidates); // quota exhaustion → empty, rung just yields fewer (doc 09)
  }

  const seen = new Set(existingKeys);
  const kept: RawCandidate[] = [];
  for (const c of raw) {
    if (!passesHygiene(c, targetHeight)) continue;
    if (
      c.provider === 'pixabay' &&
      c.kind === 'video' &&
      !matchesOrientation(c.width, c.height, orientation)
    ) {
      continue;
    }
    const key = `${c.provider}:${c.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(c);
    if (kept.length >= LADDER_ADD_CAP) break;
  }
  if (kept.length === 0) return [];

  const limit = pLimit(THUMB_PARALLELISM);
  const withThumbs = (
    await Promise.all(
      kept.map((c) =>
        limit(async () => {
          const thumb = await ensureThumb(c, ctx.signal);
          return thumb ? { c, thumb } : null;
        }),
      ),
    )
  ).filter((x): x is { c: RawCandidate; thumb: string } => x !== null);
  if (withThumbs.length === 0) return [];

  const inserts: db.CandidateInsert[] = withThumbs.map(({ c, thumb }) => ({
    beatId: beat.id,
    provider: c.provider,
    providerId: c.providerId,
    kind: c.kind,
    width: c.width,
    height: c.height,
    ...(c.duration !== undefined ? { duration: c.duration } : {}),
    thumbPath: thumb,
    remoteUrl: c.downloadUrl,
    pageUrl: c.pageUrl,
    author: c.author,
    license: c.license,
    ...(c.meta !== undefined ? { meta: c.meta } : {}),
  }));
  const rows = await db.appendCandidatesForBeat(beat.id, inserts);

  const thumbPaths = rows.flatMap((r) => (r.thumb_path ? [r.thumb_path] : []));
  const emb = await embedImage(thumbPaths, ctx.signal);
  const byPath = new Map<string, number[]>();
  thumbPaths.forEach((p, i) => {
    if (!emb.failed.includes(p)) byPath.set(p, emb.vectors[i] ?? []);
  });

  const out: SelectionCandidate[] = [];
  for (const row of rows) {
    if (!row.thumb_path) continue;
    const te = byPath.get(row.thumb_path);
    if (!te) continue;
    out.push({
      id: row.id,
      assetKey: `${row.provider}:${row.provider_id}`,
      author: row.author,
      features: {
        kind: row.kind === 'video' ? 'video' : 'image',
        isIllustration: false,
        width: Number(row.width ?? 0),
        height: Number(row.height ?? 0),
        durationSec: row.duration == null ? null : Number(row.duration),
        fps: null,
      },
      sim: cosine(anchor, te),
      thumbEmbedding: te,
    });
  }
  return out;
}

async function makeTextcard(beat: LadderBeat, ctx: ProjectCtx): Promise<SelectionCandidate> {
  const theme = themeForEmotion(beat.emotion);
  const outPath = join(paths.projectDir(ctx.projectId), 'media', 'textcards', `${beat.idx}.png`);
  await renderTextcard(
    { phrase: beat.keyPhrase || ' ', emotion: beat.emotion, aspect: beat.aspect, theme, outPath },
    ctx.signal,
  );
  const [w, h] = TARGET_DIMS[beat.aspect] ?? [1920, 1080];
  const [row] = await db.appendCandidatesForBeat(beat.id, [
    {
      beatId: beat.id,
      provider: 'textcard',
      providerId: `textcard-${beat.idx}`,
      kind: 'textcard',
      width: w,
      height: h,
      thumbPath: outPath,
      remoteUrl: outPath,
      author: 'ScriptReel',
      license: 'Generated',
      meta: { theme },
    },
  ]);
  if (!row) throw new Error('textcard candidate insert returned no row');
  return {
    id: row.id,
    assetKey: `textcard:${beat.idx}`,
    author: 'ScriptReel',
    features: {
      kind: 'image',
      isIllustration: false,
      width: w,
      height: h,
      durationSec: null,
      fps: null,
    },
    sim: 1, // the card is the deliberate choice — score it above τ_hi
    thumbEmbedding: [],
  };
}

// Rung 4 — generative fallback (doc 25 §5-E). Generate an image with FLUX.1-schnell (via the
// isolated services/gen venv) for an abstract/non-entity beat and persist it as a candidate.
// Returns null when the generator is unavailable / fails (→ the ladder drops to the text
// card) — a missing generator NEVER fails a render (invariant 7). The caller guarantees
// beat.nonEntity, so this never fabricates a real named subject.
async function makeGenerated(
  beat: LadderBeat,
  ctx: ProjectCtx,
): Promise<SelectionCandidate | null> {
  const prompt = beat.visualDescription || beat.conceptual || beat.keyPhrase;
  if (!prompt.trim()) return null; // nothing to describe → let the text card handle it
  const [w, h] = GEN_DIMS[beat.aspect] ?? GEN_DIMS['16:9'] ?? [1024, 576];
  const outPath = join(paths.projectDir(ctx.projectId), 'media', 'generated', `${beat.idx}.png`);
  await mkdir(dirname(outPath), { recursive: true });

  const generated = await generateImage({
    prompt,
    width: w,
    height: h,
    outPath,
    signal: ctx.signal,
    log: ctx.log,
  });
  if (!generated) return null; // unavailable / errored / timed out → degrade to the text card

  const [row] = await db.appendCandidatesForBeat(beat.id, [
    {
      beatId: beat.id,
      provider: 'generated',
      providerId: `generated-${beat.idx}`,
      kind: 'generated',
      width: w,
      height: h,
      thumbPath: outPath,
      remoteUrl: outPath,
      author: 'ScriptReel',
      license: 'Generated',
      meta: { prompt },
    },
  ]);
  if (!row) return null; // insert conflicted (nothing returned) → fall through to the card
  return {
    id: row.id,
    assetKey: `generated:${beat.idx}`,
    author: 'ScriptReel',
    features: {
      kind: 'image',
      isIllustration: false,
      width: w,
      height: h,
      durationSec: null,
      fps: null,
    },
    sim: 1, // the generated image is the deliberate choice — score it above τ_hi (like the card)
    thumbEmbedding: [],
  };
}

// Run the fallback ladder for one unresolved beat (doc 09 §4, doc 25 §5-E). Rungs 1–3 fire
// more searches; Rung 4 generates an image for an abstract (non-entity) beat, degrading to
// the card when the generator is absent; Rung 5 (text card) always succeeds.
export async function runLadder(beat: LadderBeat, deps: LadderDeps): Promise<LadderResult> {
  const { scoreCtx } = deps;
  const pool: SelectionCandidate[] = [...beat.existing];
  const scoreOf = (c: SelectionCandidate): number =>
    baseScore(c.sim, c.features, scoreCtx, beat.beatDurationSec).base;

  const finish = (rung: Rung, chosen: SelectionCandidate): LadderResult => {
    const ranked = [...pool]
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .map((c, i) => ({ id: c.id, score: scoreOf(c), rank: i }));
    return {
      chosenId: chosen.id,
      chosenAssetKey: chosen.assetKey,
      rung,
      weak: scoreOf(chosen) < TAU_HI,
      ranked,
    };
  };

  const bestAbove = (
    candidates: SelectionCandidate[],
    threshold: number,
  ): SelectionCandidate | null => {
    let best: SelectionCandidate | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const c of candidates) {
      if (deps.chosenAssetKeys.has(c.assetKey)) continue; // reuse avoidance
      const s = scoreOf(c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best && bestScore >= threshold ? best : null;
  };

  if (!beat.forcedTextcard) {
    // Rung 1 — broaden the head noun phrase, re-search video (both providers).
    const broadenReqs = broadenQuery(beat.literal0).flatMap<PlannedRequest>((q) => [
      { provider: 'pexels', kind: 'video', query: q },
      { provider: 'pixabay', kind: 'video', query: q },
    ]);
    if (broadenReqs.length > 0) {
      const added = await fireRung(beat, broadenReqs, beat.descEmbedding, deps, keysOf(pool));
      pool.push(...added);
      const best = bestAbove(pool, TAU_LO);
      if (best) return finish('broaden', best);
    }

    // Rung 2 — conceptual tier (video + image).
    if (beat.conceptual) {
      const added = await fireRung(
        beat,
        bothProviders(beat.conceptual),
        beat.descEmbedding,
        deps,
        keysOf(pool),
      );
      pool.push(...added);
      const best = bestAbove(pool, TAU_LO);
      if (best) return finish('conceptual', best);
    }

    // Rung 3 — mood tier, scored against a mood-anchored text (matching feeling, not
    // content); accept at the lower τ_mood.
    if (beat.mood) {
      const anchorText = `${beat.mood}, ${beat.emotion} atmosphere`;
      const anchorRes = await embedText([anchorText], deps.ctx.signal);
      const anchor = anchorRes.vectors[0] ?? beat.descEmbedding;
      const added = await fireRung(beat, bothProviders(beat.mood), anchor, deps, keysOf(pool));
      pool.push(...added);
      const best = bestAbove(added, TAU_MOOD); // only the mood-scored additions qualify here
      if (best) return finish('mood', best);
    }
  }

  // Rung 4 — generative fallback (doc 25 §5-E). Non-entity/abstract beats ONLY: never
  // fabricate a real named subject. Degrades to the text card when the generator is absent.
  if (!beat.forcedTextcard && beat.nonEntity) {
    const gen = await makeGenerated(beat, deps.ctx);
    if (gen) {
      pool.push(gen);
      return finish('generated', gen);
    }
  }

  // Rung 5 — text card. Always succeeds (doc 07 invariant 7).
  const card = await makeTextcard(beat, deps.ctx);
  pool.push(card);
  return finish(beat.forcedTextcard ? 'forced_textcard' : 'textcard', card);
}
