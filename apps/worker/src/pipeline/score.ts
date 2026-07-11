import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  cosine,
  hashObject,
  invariant,
  isArchiveProvider,
  PipelineError,
  planMontage,
  planSemanticMontage,
  type Rung,
  type ScoreContext,
  type SelectionBeat,
  type SelectionCandidate,
  type SubtitleAspect,
  selectBeats,
  targetHeightForAspect,
  varietyPass,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { QuotaGuard } from '../providers/quota-guard';
import { SearchClient } from '../providers/search';
import { embedImage, embedText } from '../sidecar/client';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';
import { type LadderBeat, runLadder } from './ladder';

const EMBED_IMAGE_BATCH = 64; // sidecar accepts ≤64 paths/call (doc 14)

function targetAspectFor(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w && h ? w / h : 16 / 9;
}

function candidateFingerprint(rows: readonly db.CandidateRow[]): unknown {
  return rows.map((c) => [c.provider, c.provider_id, c.thumb_path, c.width, c.height, c.duration]);
}

// A beat "names a specific subject" (doc 23 §6.3) when analyze extracted a person or
// place — the cases where a generic stand-in would be wrong. Objects (e.g. "a bridge")
// are generic enough to leave to stock, so they don't trigger the stricter cross-check.
function beatNamesSubject(entities: db.BeatRow['entities']): boolean {
  const e = entities as { people?: unknown[]; places?: unknown[] } | null;
  return (e?.people?.length ?? 0) > 0 || (e?.places?.length ?? 0) > 0;
}

// Ordered visual-moment phrases for a beat (doc 23 §7b); [] for a single-image beat.
function parseMoments(raw: db.BeatRow['visual_moments']): string[] {
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : [];
}

// score stage (doc 09): embed each beat's visualDescription + every candidate thumb
// (SigLIP 2), score, greedily select with τ thresholds, run the variety pass, persist
// rank/score + chosen_candidate_id, and write selection.json (the tuning instrument).
export const scoreStage: Stage = {
  name: 'score',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const beats = await db.getBeats(ctx.projectId);
    const candidateSets = await Promise.all(
      beats.map((b) => db.getCandidatesForBeat(b.id).then(candidateFingerprint)),
    );
    return hashObject({
      stage: 'score',
      logic: 'montage-2', // bump to re-run score when the selection logic changes (doc 23 §7)
      descriptions: beats.map((b) => b.visual_description ?? b.text),
      moments: beats.map((b) => parseMoments(b.visual_moments)),
      estSeconds: beats.map((b) => Number(b.est_seconds ?? 0)),
      forcedTextcard: beats.map((b) => b.forced_textcard),
      namedSubject: beats.map((b) => beatNamesSubject(b.entities)), // cross-check (doc 23 §6)
      candidates: candidateSets,
      aspect: ctx.settings.aspect,
      mediaPreference: ctx.settings.mediaPreference,
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    const beats = await db.getBeats(ctx.projectId);
    invariant(beats.length > 0, 'no beats to score — run analyze first', 'score');

    const { aspect, mediaPreference } = ctx.settings;
    const scoreCtx: ScoreContext = {
      targetHeight: targetHeightForAspect(aspect),
      targetAspect: targetAspectFor(aspect),
      mixedMode: mediaPreference === 'mixed',
    };

    // Candidates per beat, in DB order (persisted rank from search).
    const candidatesByBeat = await Promise.all(beats.map((b) => db.getCandidatesForBeat(b.id)));

    // 1) Embed beat descriptions (one call) + all candidate thumbs (batched, cached).
    report(10, 'embedding beat descriptions');
    const descriptions = beats.map((b) => b.visual_description ?? b.text);
    const descRes = await embedText(descriptions, ctx.signal);

    // Embed montage moment phrases (doc 23 §7b), deduped across beats, so each moment
    // can be matched to its best clip.
    const momentPhrases = [...new Set(beats.flatMap((b) => parseMoments(b.visual_moments)))];
    const momentRes =
      momentPhrases.length > 0
        ? await embedText(momentPhrases, ctx.signal)
        : { vectors: [] as number[][], dim: descRes.dim };
    const momentEmbByPhrase = new Map(momentPhrases.map((p, i) => [p, momentRes.vectors[i] ?? []]));

    const uniquePaths = [
      ...new Set(candidatesByBeat.flat().flatMap((c) => (c.thumb_path ? [c.thumb_path] : []))),
    ];
    const thumbEmbeddings = new Map<string, number[]>();
    const failedThumbs = new Set<string>();
    for (let i = 0; i < uniquePaths.length; i += EMBED_IMAGE_BATCH) {
      if (ctx.signal.aborted) throw new PipelineError('E_CANCELLED', 'score', 'cancelled');
      const batch = uniquePaths.slice(i, i + EMBED_IMAGE_BATCH);
      const res = await embedImage(batch, ctx.signal);
      for (const f of res.failed) failedThumbs.add(f);
      batch.forEach((path, j) => {
        if (!res.failed.includes(path)) {
          const vec = res.vectors[j];
          if (vec) thumbEmbeddings.set(path, vec);
        }
      });
      report(
        10 + Math.round((40 * (i + batch.length)) / Math.max(1, uniquePaths.length)),
        JSON.stringify({
          op: 'embed',
          done: Math.min(i + batch.length, uniquePaths.length),
          total: uniquePaths.length,
        }),
      );
    }

    // 2) Build selection beats: sim = cosine(descEmbedding, thumbEmbedding).
    const selectionBeats: SelectionBeat[] = beats.map((beat, i) => {
      const descEmbedding = descRes.vectors[i] ?? [];
      const rows = candidatesByBeat[i] ?? [];
      const candidates: SelectionCandidate[] = [];
      for (const c of rows) {
        if (!c.thumb_path) continue;
        const thumbEmbedding = thumbEmbeddings.get(c.thumb_path);
        if (!thumbEmbedding) continue; // failed/dropped thumb
        candidates.push({
          id: c.id,
          assetKey: `${c.provider}:${c.provider_id}`,
          author: c.author,
          features: {
            // generated/textcard candidates (Phase 7 ladder) are still image-like here
            kind: c.kind === 'video' ? 'video' : 'image',
            isIllustration: false, // Pixabay illustration tagging lands with Phase 7
            width: Number(c.width ?? 0),
            height: Number(c.height ?? 0),
            durationSec: c.duration == null ? null : Number(c.duration),
            fps: null, // real fps only known post-fetch (ffprobe); fpsFit uses 0.5 for videos
          },
          sim: cosine(descEmbedding, thumbEmbedding),
          thumbEmbedding,
          isArchive: isArchiveProvider(c.provider), // cross-check (doc 23 §6)
        });
      }
      return {
        beatIdx: beat.idx,
        beatDurationSec: Number(beat.est_seconds ?? 0),
        candidates,
        namedSubject: beatNamesSubject(beat.entities),
      };
    });

    // 3) Greedy selection + global variety pass (doc 09 §3, §5).
    report(55, 'selecting best asset per beat');
    const firstPass = selectBeats(selectionBeats, scoreCtx);
    const selections = varietyPass(selectionBeats, firstPass, scoreCtx);

    // 4) Resolve each beat: primary selection, else the fallback ladder (doc 09 §4).
    const client = new SearchClient(new QuotaGuard(ctx.log), ctx.log);
    const chosenAssetKeys = new Set<string>();
    for (let i = 0; i < beats.length; i += 1) {
      const sel = selections[i];
      const sc = selectionBeats[i];
      if (sel?.chosenId && sc) {
        const chosen = sc.candidates.find((c) => c.id === sel.chosenId);
        if (chosen) chosenAssetKeys.add(chosen.assetKey);
      }
    }

    const selectionLog: unknown[] = [];
    const warnings: string[] = [];
    const rungCounts: Record<string, number> = {};
    let chosenCount = 0;
    let weakCount = 0;
    let montageCount = 0;
    for (let i = 0; i < beats.length; i += 1) {
      const beat = beats[i];
      const sel = selections[i];
      const sc = selectionBeats[i];
      if (!beat || !sel || !sc) continue;

      let chosenId: string | null = sel.chosenId;
      let rung: Rung = sel.rungUsed;
      let weak = sel.weak;
      let ranked = sel.ranked;
      let chosenAssetKey: string | null = sel.chosenId
        ? (sc.candidates.find((c) => c.id === sel.chosenId)?.assetKey ?? null)
        : null;

      // Escalate when tier-1 left the beat unresolved, or the user forced a text card.
      if (beat.forced_textcard || sel.chosenId === null) {
        const queries = beat.queries as {
          literal?: string[];
          conceptual?: string;
          mood?: string;
        } | null;
        const ladderBeat: LadderBeat = {
          id: beat.id,
          idx: beat.idx,
          keyPhrase: beat.key_phrase ?? '',
          emotion: beat.emotion ?? 'neutral',
          aspect: aspect as SubtitleAspect,
          descEmbedding: descRes.vectors[i] ?? [],
          literal0: queries?.literal?.[0] ?? '',
          conceptual: queries?.conceptual ?? '',
          mood: queries?.mood ?? '',
          beatDurationSec: Number(beat.est_seconds ?? 0),
          existing: sc.candidates,
          forcedTextcard: beat.forced_textcard,
        };
        const result = await runLadder(ladderBeat, { ctx, scoreCtx, client, chosenAssetKeys });
        chosenId = result.chosenId;
        chosenAssetKey = result.chosenAssetKey;
        rung = result.rung;
        weak = result.weak;
        ranked = result.ranked;
      }

      if (chosenId) {
        if (chosenAssetKey) chosenAssetKeys.add(chosenAssetKey); // reuse set for later ladders
        chosenCount += 1;
        if (weak) weakCount += 1;
      } else {
        warnings.push(`E_NO_CANDIDATES: beat ${beat.idx} unresolved after ladder`);
      }
      rungCounts[rung] = (rungCounts[rung] ?? 0) + 1;

      // Montage plan (doc 23 §7): split a long beat into diverse segments from its
      // scored candidates. Only when the chosen clip is among the scored pool (primary
      // tier); the ladder's text-card/generated picks aren't montaged.
      const scoreById = new Map(ranked.map((r) => [r.id, r.score]));
      const montageCandidates = sc.candidates.map((c) => ({
        id: c.id,
        kind: c.features.kind === 'video' ? ('video' as const) : ('image' as const),
        score: scoreById.get(c.id) ?? 0,
        thumbEmbedding: c.thumbEmbedding,
      }));
      // Semantic montage first (each moment → its best clip); fall back to the diverse
      // planner when analyze gave no moments or too few assign (doc 23 §7b).
      const moments = parseMoments(beat.visual_moments);
      const diverse = () =>
        planMontage(chosenId ?? '', montageCandidates, Number(beat.est_seconds ?? 0));
      let segments: ReturnType<typeof planMontage> = null;
      if (chosenId) {
        if (moments.length >= 2) {
          const momentInputs = moments.map((p) => ({
            embedding: momentEmbByPhrase.get(p) ?? [],
            weight: p.split(/\s+/).filter(Boolean).length || 1,
          }));
          segments = planSemanticMontage(momentInputs, montageCandidates) ?? diverse();
        } else {
          segments = diverse();
        }
      }
      if (segments) montageCount += 1;
      await db.applyBeatSelection(beat.id, ranked, chosenId, segments);
      const top = ranked[0];
      selectionLog.push({
        beatIdx: beat.idx,
        chosen: chosenId,
        rungUsed: rung,
        weak,
        topScore: top ? Number(top.score.toFixed(4)) : null,
        candidateCount: ranked.length,
        scores: ranked
          .slice(0, 8)
          .map((r) => ({ id: r.id, score: Number(r.score.toFixed(4)), rank: r.rank })),
      });
      report(
        55 + Math.round((40 * (i + 1)) / beats.length),
        JSON.stringify({ op: 'select', beat: i + 1, of: beats.length }),
      );
    }

    const scoreDir = join(paths.projectDir(ctx.projectId), 'stages', 'score');
    await mkdir(scoreDir, { recursive: true });
    await writeFile(
      join(scoreDir, 'selection.json'),
      JSON.stringify(selectionLog, null, 2),
      'utf8',
    );

    report(100, `${chosenCount}/${beats.length} beats resolved`);
    return {
      artifacts: ['stages/score/selection.json'],
      warnings,
      meta: {
        beats: beats.length,
        chosen: chosenCount,
        weak: weakCount,
        montage: montageCount,
        rungs: rungCounts,
        thumbsEmbedded: thumbEmbeddings.size,
        thumbsFailed: failedThumbs.size,
        dim: descRes.dim,
      },
    };
  },
};
