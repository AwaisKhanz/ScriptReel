import {
  hashObject,
  invariant,
  MAX_CANDIDATES_PER_BEAT,
  matchesOrientation,
  normalizeSearchQuery,
  orientationForAspect,
  PER_PAGE_PHOTO,
  PER_PAGE_VIDEO,
  PipelineError,
  passesHygiene,
  planTier1Requests,
  type RawCandidate,
  type SearchQuery,
  targetHeightForAspect,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pLimit from 'p-limit';
import { QuotaGuard } from '../providers/quota-guard';
import { SearchClient } from '../providers/search';
import { ensureThumb } from '../providers/thumbs';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

const THUMB_PARALLELISM = 4;

// search stage (doc 08, tier-1 only): per beat, fire the planned provider requests
// through cache+quota, apply hygiene, dedupe, cap at 40, download thumbs, persist
// candidates. Tiers 2–3 belong to the score stage's fallback ladder (doc 09).
export const searchStage: Stage = {
  name: 'search',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const beats = await db.getBeats(ctx.projectId);
    return hashObject({
      stage: 'search',
      queries: beats.map((b) => b.queries),
      aspect: ctx.settings.aspect,
      mediaPreference: ctx.settings.mediaPreference,
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    const beats = await db.getBeats(ctx.projectId);
    invariant(beats.length > 0, 'no beats to search — run analyze first', 'search');

    const { aspect, mediaPreference } = ctx.settings;
    const orientation = orientationForAspect(aspect);
    const targetHeight = targetHeightForAspect(aspect);
    const client = new SearchClient(new QuotaGuard(ctx.log), ctx.log);

    // Cross-beat dedupe: identical (provider,kind,normalizedQuery) fires once (doc 08).
    const requestCache = new Map<string, RawCandidate[]>();
    const limit = pLimit(THUMB_PARALLELISM);
    const warnings: string[] = [];
    let networkCalls = 0;
    let cacheHits = 0;
    let thumbFailures = 0;
    let beatsWithCandidates = 0;

    for (let i = 0; i < beats.length; i += 1) {
      if (ctx.signal.aborted) throw new PipelineError('E_CANCELLED', 'search', 'cancelled');
      const beat = beats[i];
      if (!beat) continue;
      const queries = beat.queries as { literal?: string[] } | null;
      const plan = planTier1Requests(queries?.literal ?? [], mediaPreference);

      const collected: RawCandidate[] = [];
      for (const req of plan) {
        const perPage = req.kind === 'video' ? PER_PAGE_VIDEO : PER_PAGE_PHOTO;
        const query: SearchQuery = { query: req.query, kind: req.kind, orientation, perPage };
        const key = `${req.provider}|${req.kind}|${orientation}|${normalizeSearchQuery(req.query)}`;
        let candidates = requestCache.get(key);
        if (!candidates) {
          const result = await client.search(query, req.provider);
          candidates = result.candidates;
          requestCache.set(key, candidates);
          if (result.cacheHit) cacheHits += 1;
          else networkCalls += 1;
        }
        collected.push(...candidates);
      }

      // Hygiene → orientation post-filter (Pixabay videos) → dedupe → cap 40.
      const seen = new Set<string>();
      const kept: RawCandidate[] = [];
      for (const c of collected) {
        if (!passesHygiene(c, targetHeight)) continue;
        if (
          c.provider === 'pixabay' &&
          c.kind === 'video' &&
          !matchesOrientation(c.width, c.height, orientation)
        ) {
          continue;
        }
        const id = `${c.provider}:${c.providerId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        kept.push(c);
        if (kept.length >= MAX_CANDIDATES_PER_BEAT) break;
      }

      // Thumbnails (max 4 parallel); a failed thumb drops that candidate (doc 08).
      const withThumbs = await Promise.all(
        kept.map((candidate) =>
          limit(async () => {
            const thumb = await ensureThumb(candidate, ctx.signal);
            if (!thumb) {
              thumbFailures += 1;
              return null;
            }
            return { candidate, thumb };
          }),
        ),
      );

      const rows: db.CandidateInsert[] = [];
      let rank = 0;
      for (const entry of withThumbs) {
        if (!entry) continue;
        const { candidate, thumb } = entry;
        rows.push({
          beatId: beat.id,
          provider: candidate.provider,
          providerId: candidate.providerId,
          kind: candidate.kind,
          width: candidate.width,
          height: candidate.height,
          ...(candidate.duration !== undefined ? { duration: candidate.duration } : {}),
          thumbPath: thumb,
          remoteUrl: candidate.downloadUrl,
          pageUrl: candidate.pageUrl,
          author: candidate.author,
          license: candidate.license,
          rank,
          ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
        });
        rank += 1;
      }

      await db.replaceCandidatesForBeat(beat.id, rows);
      if (rows.length > 0) beatsWithCandidates += 1;
      else warnings.push(`E_NO_CANDIDATES: beat ${beat.idx} has no candidates after hygiene`);

      report(Math.round(((i + 1) / beats.length) * 100), `search beat ${i + 1}/${beats.length}`);
    }

    return {
      warnings,
      meta: {
        beats: beats.length,
        beatsWithCandidates,
        networkCalls,
        cacheHits,
        thumbFailures,
      },
    };
  },
};
