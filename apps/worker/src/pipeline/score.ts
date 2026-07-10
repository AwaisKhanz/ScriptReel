import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  cosine,
  hashObject,
  invariant,
  PipelineError,
  type ScoreContext,
  type SelectionBeat,
  type SelectionCandidate,
  selectBeats,
  targetHeightForAspect,
  varietyPass,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { embedImage, embedText } from '../sidecar/client';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

const EMBED_IMAGE_BATCH = 64; // sidecar accepts ≤64 paths/call (doc 14)

function targetAspectFor(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w && h ? w / h : 16 / 9;
}

function candidateFingerprint(rows: readonly db.CandidateRow[]): unknown {
  return rows.map((c) => [c.provider, c.provider_id, c.thumb_path, c.width, c.height, c.duration]);
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
      descriptions: beats.map((b) => b.visual_description ?? b.text),
      estSeconds: beats.map((b) => Number(b.est_seconds ?? 0)),
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
        'embedding thumbnails',
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
        });
      }
      return { beatIdx: beat.idx, beatDurationSec: Number(beat.est_seconds ?? 0), candidates };
    });

    // 3) Greedy selection + global variety pass (doc 09 §3, §5).
    report(55, 'selecting best asset per beat');
    const firstPass = selectBeats(selectionBeats, scoreCtx);
    const selections = varietyPass(selectionBeats, firstPass, scoreCtx);

    // 4) Persist rank/score + chosen asset; collect the selection audit trail.
    const selectionLog: unknown[] = [];
    const warnings: string[] = [];
    let chosenCount = 0;
    let weakCount = 0;
    let unresolvedCount = 0;
    for (let i = 0; i < beats.length; i += 1) {
      const beat = beats[i];
      const sel = selections[i];
      if (!beat || !sel) continue;
      await db.applyBeatSelection(beat.id, sel.ranked, sel.chosenId);
      if (sel.chosenId) {
        chosenCount += 1;
        if (sel.weak) weakCount += 1;
      } else {
        unresolvedCount += 1;
        warnings.push(
          `E_NO_CANDIDATES: beat ${beat.idx} unresolved (best < τ_lo) — ladder pending`,
        );
      }
      const top = sel.ranked[0];
      selectionLog.push({
        beatIdx: beat.idx,
        chosen: sel.chosenId,
        rungUsed: sel.rungUsed,
        weak: sel.weak,
        topScore: top ? Number(top.score.toFixed(4)) : null,
        candidateCount: sel.ranked.length,
        scores: sel.ranked
          .slice(0, 8)
          .map((r) => ({ id: r.id, score: Number(r.score.toFixed(4)), rank: r.rank })),
      });
      report(
        55 + Math.round((40 * (i + 1)) / beats.length),
        `scored beat ${i + 1}/${beats.length}`,
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
        unresolved: unresolvedCount,
        thumbsEmbedded: thumbEmbeddings.size,
        thumbsFailed: failedThumbs.size,
        dim: descRes.dim,
      },
    };
  },
};
