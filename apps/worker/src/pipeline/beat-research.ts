import {
  type BeatResearchPayload,
  baseScore,
  cosine,
  matchesOrientation,
  orientationForAspect,
  PER_PAGE_PHOTO,
  PER_PAGE_VIDEO,
  type PlannedRequest,
  parseSettings,
  passesHygiene,
  type RawCandidate,
  type ScoreContext,
  type SelectionCandidate,
  type SubtitleAspect,
  TAU_LO,
  targetHeightForAspect,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import { QuotaGuard } from '../providers/quota-guard';
import { SearchClient } from '../providers/search';
import { ensureThumb } from '../providers/thumbs';
import { embedImage, embedText } from '../sidecar/client';

const RESEARCH_CAP = 24; // storyboard re-search stays small + budgeted (doc 08 reserve)

function aspectRatio(aspect: string): number {
  return aspect === '9:16' ? 9 / 16 : aspect === '1:1' ? 1 : 16 / 9;
}

// beat-research queue (doc 06 / doc 09 §single-beat re-search): re-search ONE beat
// from the storyboard (edited description and/or a custom query), append candidates,
// re-embed + re-rank, and re-choose the new top-1 if it clears τ_lo. Never touches
// other beats. Changing the selection auto-invalidates fetch+compose via inputsHash.
export async function runBeatResearch(
  payload: BeatResearchPayload,
  log: Logger,
): Promise<{ candidateCount: number; chosenId: string | null; added: number }> {
  const project = await db.getProject(payload.projectId);
  if (!project) throw new Error(`project ${payload.projectId} not found`);
  const settings = parseSettings(project.settings);
  const beat = (await db.getBeats(payload.projectId)).find((b) => b.id === payload.beatId);
  if (!beat) throw new Error(`beat ${payload.beatId} not found`);

  if (payload.visualDescription) {
    await db.setBeatVisualDescription(beat.id, payload.visualDescription);
  }
  const description = payload.visualDescription ?? beat.visual_description ?? beat.text;

  const aspect = settings.aspect as SubtitleAspect;
  const orientation = orientationForAspect(aspect);
  const targetHeight = targetHeightForAspect(aspect);
  const scoreCtx: ScoreContext = {
    targetHeight,
    targetAspect: aspectRatio(aspect),
    mixedMode: settings.mediaPreference === 'mixed',
  };
  const signal = AbortSignal.timeout(120_000);

  // 1) Fire search: the custom query if given, else the beat's literals; both providers.
  const queries = payload.customQuery
    ? [payload.customQuery]
    : ((beat.queries as { literal?: string[] } | null)?.literal ?? []);
  const requests: PlannedRequest[] = queries
    .filter((q) => q.length > 0)
    .flatMap((query) => [
      { provider: 'pexels' as const, kind: 'video' as const, query },
      { provider: 'pixabay' as const, kind: 'video' as const, query },
      { provider: 'pixabay' as const, kind: 'image' as const, query },
    ]);

  const existing = await db.getCandidatesForBeat(beat.id);
  const seen = new Set(existing.map((c) => `${c.provider}:${c.provider_id}`));
  const client = new SearchClient(new QuotaGuard(log), log);
  const raw: RawCandidate[] = [];
  for (const r of requests) {
    const res = await client.search(
      {
        query: r.query,
        kind: r.kind,
        orientation,
        perPage: r.kind === 'video' ? PER_PAGE_VIDEO : PER_PAGE_PHOTO,
      },
      r.provider,
    );
    raw.push(...res.candidates);
  }

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
    if (kept.length >= RESEARCH_CAP) break;
  }

  const limit = pLimit(4);
  const resolved = (
    await Promise.all(
      kept.map((c) =>
        limit(async () => {
          const thumb = await ensureThumb(c, signal);
          return thumb ? { c, thumb } : null;
        }),
      ),
    )
  ).filter((x): x is { c: RawCandidate; thumb: string } => x !== null);

  let added = 0;
  if (resolved.length > 0) {
    const inserted = await db.appendCandidatesForBeat(
      beat.id,
      resolved.map(({ c, thumb }) => ({
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
      })),
    );
    added = inserted.length;
  }

  // 2) Re-embed + re-score every candidate for the beat, re-rank, re-choose.
  const rows = await db.getCandidatesForBeat(beat.id);
  const descEmbedding = (await embedText([description], signal)).vectors[0] ?? [];
  const thumbPaths = rows.flatMap((r) => (r.thumb_path ? [r.thumb_path] : []));
  const emb = await embedImage(thumbPaths, signal);
  const byPath = new Map<string, number[]>();
  thumbPaths.forEach((p, i) => {
    if (!emb.failed.includes(p)) byPath.set(p, emb.vectors[i] ?? []);
  });

  const beatDur = Number(beat.est_seconds ?? 0);
  const scoreOf = (c: SelectionCandidate): number =>
    baseScore(c.sim, c.features, scoreCtx, beatDur).base;
  const cands: SelectionCandidate[] = [];
  for (const row of rows) {
    if (!row.thumb_path) continue;
    const te = byPath.get(row.thumb_path);
    if (!te) continue;
    cands.push({
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
      sim: cosine(descEmbedding, te),
      thumbEmbedding: te,
    });
  }

  const ranked = [...cands]
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .map((c, i) => ({ id: c.id, score: scoreOf(c), rank: i }));
  const top = ranked[0];
  const chosenId = top && top.score >= TAU_LO ? top.id : null;
  await db.applyBeatSelection(beat.id, ranked, chosenId);
  log.info(
    { beatId: beat.id, added, candidateCount: ranked.length, chosenId },
    'beat re-search done',
  );
  return { candidateCount: ranked.length, chosenId, added };
}
