import {
  classifyDomain,
  hashObject,
  invariant,
  isLicenseAllowed,
  MAX_CANDIDATES_PER_BEAT,
  matchesOrientation,
  normalizeSearchQuery,
  orientationForAspect,
  PER_PAGE_PHOTO,
  PER_PAGE_VIDEO,
  PipelineError,
  type PlannedRequest,
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

// Bounded concurrency (doc 06): beats overlap and provider requests overlap, but both
// are capped so the burst stays polite. Total request COUNT is unchanged (QuotaGuard
// reserves atomically per request), so quota use is identical to the serial path —
// only wall-clock shrinks.
const BEAT_PARALLELISM = 3;
const REQUEST_PARALLELISM = 4;
const THUMB_PARALLELISM = 4;

// Ordered visual-moment phrases for a beat (doc 23 §7b); [] for a single-image beat.
function parseMoments(raw: db.BeatRow['visual_moments']): string[] {
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : [];
}

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
      moments: beats.map((b) => parseMoments(b.visual_moments)), // per-moment search (doc 23 §7b)
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
    // Promise-cached so concurrent beats firing the same query share one in-flight
    // HTTP request instead of double-spending quota.
    const requestCache = new Map<string, Promise<RawCandidate[]>>();
    const reqLimit = pLimit(REQUEST_PARALLELISM);
    const beatLimit = pLimit(BEAT_PARALLELISM);
    const limit = pLimit(THUMB_PARALLELISM); // thumbs: one global bound across beats
    const warnings: string[] = [];
    let networkCalls = 0;
    let cacheHits = 0;
    let thumbFailures = 0;
    let beatsWithCandidates = 0;
    let doneBeats = 0;
    const pctNow = () => Math.round((doneBeats / beats.length) * 100);

    const fetchRequest = (req: PlannedRequest): Promise<RawCandidate[]> => {
      const key = `${req.provider}|${req.kind}|${orientation}|${normalizeSearchQuery(req.query)}`;
      let pending = requestCache.get(key);
      if (!pending) {
        pending = reqLimit(async () => {
          const perPage = req.kind === 'video' ? PER_PAGE_VIDEO : PER_PAGE_PHOTO;
          const query: SearchQuery = { query: req.query, kind: req.kind, orientation, perPage };
          const result = await client.search(query, req.provider);
          if (result.cacheHit) cacheHits += 1;
          else networkCalls += 1;
          // Live activity event (doc 16): what was just searched and how much it found.
          report(
            pctNow(),
            JSON.stringify({
              op: 'search',
              provider: req.provider,
              kind: req.kind,
              query: req.query,
              found: result.candidates.length,
            }),
          );
          return result.candidates;
        });
        requestCache.set(key, pending);
      }
      return pending;
    };

    const searchBeat = async (beat: db.BeatRow): Promise<void> => {
      if (ctx.signal.aborted) throw new PipelineError('E_CANCELLED', 'search', 'cancelled');
      const queries = beat.queries as { literal?: string[] } | null;
      // Domain-route archive providers (doc 23 §5) from the beat's analysis fields.
      const domain = classifyDomain(
        `${beat.visual_description ?? ''} ${beat.key_phrase ?? ''} ${beat.text}`,
      );
      const plan = planTier1Requests(queries?.literal ?? [], mediaPreference, domain);

      // Per-moment pool enrichment (doc 23 §7b): give a montage beat a purpose-found
      // clip for each of its visual moments, so score's semantic matcher has one to
      // assign. Lean (1 video + 1 image per moment, respecting mediaPreference) to keep
      // quota bounded; image sources alternate pixabay/openverse so the pool isn't a
      // single-provider monoculture. The 40-cap + round-robin still balance the pool.
      parseMoments(beat.visual_moments).forEach((moment, mi) => {
        const q = normalizeSearchQuery(moment);
        if (!q) return;
        if (mediaPreference !== 'photos')
          plan.push({ provider: 'pexels', kind: 'video', query: q });
        if (mediaPreference !== 'videos')
          plan.push({ provider: mi % 2 === 0 ? 'pixabay' : 'openverse', kind: 'image', query: q });
      });

      // All of this beat's requests in flight together (bounded by reqLimit);
      // Promise.all preserves plan order, so the round-robin interleave — and thus
      // per-beat ranking — is byte-identical to the serial path.
      const groups: RawCandidate[][] = await Promise.all(plan.map(fetchRequest));

      // Round-robin interleave across the plan's providers so every source is
      // represented before the MAX_CANDIDATES_PER_BEAT cap (doc 23). Otherwise the
      // first plan entries (stock video) fill the cap and starve later sources like
      // Openverse; scoring (doc 09) then ranks the mixed pool on merit.
      const collected: RawCandidate[] = [];
      for (let r = 0; groups.some((g) => r < g.length); r += 1) {
        for (const g of groups) {
          const c = g[r];
          if (c) collected.push(c);
        }
      }

      // Hygiene → orientation post-filter (Pixabay videos) → dedupe → cap 40.
      const seen = new Set<string>();
      const kept: RawCandidate[] = [];
      for (const c of collected) {
        if (!isLicenseAllowed(c.license)) continue; // no-strike gate (doc 23 §3)
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

      doneBeats += 1;
      report(pctNow(), JSON.stringify({ op: 'beat', beat: doneBeats, of: beats.length }));
    };

    // Beats overlap (bounded); per-beat work and persistence stay independent, so
    // completion order doesn't matter. Cancellation propagates via E_CANCELLED.
    await Promise.all(beats.map((beat) => beatLimit(() => searchBeat(beat))));

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
