import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  cosine,
  type Era,
  hashObject,
  invariant,
  isArchiveProvider,
  MONTAGE_DIVERSITY_RELAXED,
  namesSubject,
  OCR_TOP_K,
  type OcrResult,
  ocrGate,
  PipelineError,
  parseEntities,
  planMontage,
  planSameSourceMontage,
  planSemanticMontage,
  type Rung,
  type ScoreContext,
  type SegmentPlanItem,
  type SelectionBeat,
  type SelectionCandidate,
  type SubtitleAspect,
  selectBeats,
  targetHeightForAspect,
  varietyPass,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { type FitItem, verifyMediaFit } from '../analysis/media-verifier';
import { QuotaGuard } from '../providers/quota-guard';
import { SearchClient } from '../providers/search';
import { embedImage, embedText, ocr } from '../sidecar/client';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';
import { applyIdentityGate } from './identity';
import { type LadderBeat, runLadder } from './ladder';
import { applyVlmGate } from './vlm';

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
  return namesSubject(parseEntities(entities));
}

// Ordered visual-moment phrases for a beat (doc 23 §7b); [] for a single-image beat.
function parseMoments(raw: db.BeatRow['visual_moments']): string[] {
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : [];
}

// A candidate's preview-frame paths (doc 25 §4). The search stage stores up to 3 frames
// for a video in meta.frames (≈10/50/90% through the clip); single-thumb and older
// candidates have none, so we fall back to thumb_path. `meta` is Json — parse defensively.
export function framesOf(c: { meta: unknown; thumb_path: string | null }): string[] {
  const meta = c.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const frames = (meta as Record<string, unknown>).frames;
    if (Array.isArray(frames)) {
      const paths = frames.filter((f): f is string => typeof f === 'string');
      if (paths.length >= 1) return paths;
    }
  }
  return c.thumb_path ? [c.thumb_path] : [];
}

// A beat's era as the OCR gate's contradiction check expects it (doc 25 §5). BeatRow.era
// is a nullable string from the DB; coerce anything unrecognised to 'timeless' (no veto).
function beatEra(raw: string | null): Era {
  return raw === 'modern' || raw === 'historical' ? raw : 'timeless';
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
      logic: 'gen-1', // bump to re-run score when the selection logic changes (doc 23 §7, doc 25 §4/§5/§6/§5-D/§5-E)
      descriptions: beats.map((b) => b.visual_description ?? b.text),
      moments: beats.map((b) => parseMoments(b.visual_moments)),
      estSeconds: beats.map((b) => Number(b.est_seconds ?? 0)),
      forcedTextcard: beats.map((b) => b.forced_textcard),
      namedSubject: beats.map((b) => beatNamesSubject(b.entities)), // cross-check (doc 23 §6)
      era: beats.map((b) => b.era), // OCR era-contradiction veto (doc 25 §5)
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

    // 1) Embed beat descriptions (one call) + every candidate frame (batched, cached).
    // A video contributes up to 3 preview frames (doc 25 §4); images contribute one.
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

    const uniquePaths = [...new Set(candidatesByBeat.flat().flatMap((c) => framesOf(c)))];
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

    // 2) Build selection beats: sim = MAX over the candidate's frames of
    // cosine(descEmbedding, frameEmbedding); the best frame's embedding becomes the
    // candidate's representative for dup-detection + montage diversity (doc 25 §4).
    let selectionBeats: SelectionBeat[] = beats.map((beat, i) => {
      const descEmbedding = descRes.vectors[i] ?? [];
      const rows = candidatesByBeat[i] ?? [];
      const candidates: SelectionCandidate[] = [];
      for (const c of rows) {
        // Judge a video on its best-matching frame: score every embedded frame and keep
        // the max, carrying that frame's embedding forward. A single-thumb candidate has
        // one frame; a candidate with no embedded frame is skipped (as a failed thumb was).
        let best: { sim: number; emb: number[] } | null = null;
        for (const path of framesOf(c)) {
          const emb = thumbEmbeddings.get(path);
          if (!emb) continue; // failed/dropped frame
          const sim = cosine(descEmbedding, emb);
          if (!best || sim > best.sim) best = { sim, emb };
        }
        if (!best) continue;
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
          sim: best.sim,
          thumbEmbedding: best.emb,
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

    // 2b) OCR gate (doc 25 §5, cascade A). OCR each beat's SigLIP top-5 shortlist
    // (highest-sim candidates) to (a) penalize watermarked / text-heavy candidates so a
    // clean alternative wins, and (b) veto ones whose burned-in text is an egregious
    // full-image overlay or contradicts a historical beat's era. A video's watermark
    // persists across frames, so we OCR its representative thumb_path, not every frame.
    //
    // DEGRADE, NEVER DIE (invariant 7): Tesseract is optional. If ocr() throws for ANY
    // reason (binary missing, sidecar down, timeout), we skip the ENTIRE gate — no
    // penalties, no vetoes — log one warning, and select exactly as before.
    const warnings: string[] = [];
    const ocrReasonById = new Map<string, string>();
    let ocrSkipped = false;
    let ocrPenalized = 0;
    let ocrVetoed = 0;

    const thumbByCandidate = new Map<string, string>();
    for (const rows of candidatesByBeat) {
      for (const c of rows) if (c.thumb_path) thumbByCandidate.set(c.id, c.thumb_path);
    }
    // Per beat: ids of the top-K candidates by sim that actually have a thumb to OCR.
    const shortlistIdsByBeat = selectionBeats.map((sb) =>
      [...sb.candidates]
        .sort((a, b) => b.sim - a.sim)
        .slice(0, OCR_TOP_K)
        .map((c) => c.id)
        .filter((id) => thumbByCandidate.has(id)),
    );
    const shortlistPaths = [
      ...new Set(
        shortlistIdsByBeat.flat().flatMap((id) => {
          const thumb = thumbByCandidate.get(id);
          return thumb ? [thumb] : [];
        }),
      ),
    ];

    if (shortlistPaths.length > 0) {
      report(52, JSON.stringify({ op: 'ocr', total: shortlistPaths.length }));
      try {
        const res = await ocr(shortlistPaths, ctx.signal);
        const ocrByPath = new Map<string, OcrResult>(
          res.results.map((r) => [
            r.path,
            { text: r.text, coverage: r.coverage, wordCount: r.wordCount },
          ]),
        );
        // Rebuild selectionBeats immutably: drop vetoed candidates, attach ocrPenalty to
        // the rest. Non-shortlisted candidates and thumbs OCR couldn't read pass untouched.
        selectionBeats = selectionBeats.map((sb, i) => {
          const era = beatEra(beats[i]?.era ?? null);
          const shortlist = new Set(shortlistIdsByBeat[i] ?? []);
          const next: SelectionCandidate[] = [];
          for (const c of sb.candidates) {
            const thumb = shortlist.has(c.id) ? thumbByCandidate.get(c.id) : undefined;
            const result = thumb ? ocrByPath.get(thumb) : undefined;
            if (!result) {
              next.push(c);
              continue;
            }
            const verdict = ocrGate(result, { era });
            if (verdict.reason) ocrReasonById.set(c.id, verdict.reason);
            if (verdict.veto) {
              ocrVetoed += 1;
              continue; // removed from the pool selectBeats sees
            }
            if (verdict.penalty > 0) {
              ocrPenalized += 1;
              next.push({ ...c, ocrPenalty: verdict.penalty });
            } else {
              next.push(c);
            }
          }
          return { ...sb, candidates: next };
        });
      } catch (err) {
        // The degrade path: leave selectionBeats untouched, apply nothing, warn once.
        ocrSkipped = true;
        ocrPenalized = 0;
        ocrVetoed = 0;
        ocrReasonById.clear();
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`OCR gate skipped — ${message}`);
        ctx.log.warn({ err }, 'OCR gate skipped — continuing without watermark/era filtering');
      }
    }

    ctx.log.info(
      {
        shortlisted: shortlistPaths.length,
        penalized: ocrPenalized,
        vetoed: ocrVetoed,
        skipped: ocrSkipped,
      },
      ocrSkipped ? 'score/gate OCR — skipped (Tesseract unavailable)' : 'score/gate OCR',
    );

    // 2c) Reference-identity gate (doc 25 §6, cascade C). For a beat naming a specific
    // person / landmark / artwork, compare its SigLIP top-5 (the same shortlist the OCR
    // gate used) to the entity's Wikidata reference image with a LOCAL model — veto a
    // lookalike person (InsightFace), penalize a wrong landmark / artwork (DINOv2).
    //
    // DEGRADE, NEVER DIE (invariant 7): the identity models are optional and NOT
    // installed by default. If the sidecar can't embed (model absent, down, timeout) the
    // gate skips entirely — no vetoes, no penalties, selection unchanged — and the first
    // failure short-circuits so no further Wikidata references are resolved.
    const identityResult = await applyIdentityGate({
      selectionBeats,
      beats,
      thumbByCandidate,
      shortlistIdsByBeat,
      cacheDir: paths.cacheDir,
      log: ctx.log,
      signal: ctx.signal,
    });
    selectionBeats = identityResult.selectionBeats;
    const identityReasonById = identityResult.reasons;
    const identityPenalized = identityResult.penalized;
    const identityVetoed = identityResult.vetoed;
    const identitySkipped = identityResult.skipped;

    ctx.log.info(
      { penalized: identityPenalized, vetoed: identityVetoed, skipped: identitySkipped },
      identitySkipped
        ? 'score/gate identity — skipped (models unavailable)'
        : 'score/gate identity',
    );

    // 2d) VLM checklist gate (doc 25 §5-D, cascade D). Run Qwen2.5-VL on each beat's top-3
    // by sim and ask a strict four-bool checklist — subject present? shot framing? era?
    // contradicting on-screen text? — vetoing no-subject / contradicting-text candidates
    // and penalizing era / shot-framing misses, so the survivor is VLM-confirmed. Adaptive
    // skip: a beat with NO named entity AND a strong SigLIP margin skips the VLM entirely.
    //
    // DEGRADE, NEVER DIE (invariant 7): the VLM model + mlx-vlm are optional and NOT
    // installed by default. This is ONE batched /vlm call; if it throws (model absent,
    // sidecar down, timeout) the gate skips entirely — no vetoes, no penalties, selection
    // unchanged — and one warning is logged.
    const vlmResult = await applyVlmGate({
      selectionBeats,
      beats,
      thumbByCandidate,
      cacheDir: paths.cacheDir,
      log: ctx.log,
      signal: ctx.signal,
    });
    selectionBeats = vlmResult.selectionBeats;
    const vlmReasonById = vlmResult.reasons;
    const vlmPenalized = vlmResult.penalized;
    const vlmVetoed = vlmResult.vetoed;
    const vlmSkipped = vlmResult.skipped;

    ctx.log.info(
      { penalized: vlmPenalized, vetoed: vlmVetoed, skipped: vlmSkipped },
      vlmSkipped ? 'score/gate VLM — skipped (Qwen2.5-VL unavailable)' : 'score/gate VLM',
    );

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
    const rungCounts: Record<string, number> = {};
    let chosenCount = 0;
    let weakCount = 0;
    let montageCount = 0;
    // Montage plans queued for media-fit verification (doc 23 §6), checked in one
    // batched pass after selection so the vision calls don't serialize the beat loop.
    const toVerify: {
      beatId: string;
      segments: SegmentPlanItem[];
      moments: string[];
      fallbackPhrase: string;
      thumbById: Map<string, string>;
    }[] = [];
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
          // Rung 4 generative fallback (doc 25 §5-E): eligible only when the beat has NO
          // visualizable named entity — so generation never fabricates a real subject.
          nonEntity: !parseEntities(beat.entities).some((e) => e.visualizable),
          visualDescription: beat.visual_description ?? beat.text,
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
        durationSec: c.features.durationSec,
      }));
      // Montage guarantee ladder (doc 23 §7b): semantic (each moment → its best clip)
      // → diverse alternates → relaxed diversity → different windows of the chosen
      // source itself. A beat long enough to montage stays a single long hold only
      // when even its own source has no spare footage.
      const moments = parseMoments(beat.visual_moments);
      let segments: SegmentPlanItem[] | null = null;
      if (chosenId) {
        const dur = Number(beat.est_seconds ?? 0);
        if (moments.length >= 2) {
          const momentInputs = moments.map((p) => ({
            embedding: momentEmbByPhrase.get(p) ?? [],
            weight: p.split(/\s+/).filter(Boolean).length || 1,
          }));
          segments = planSemanticMontage(momentInputs, montageCandidates);
        }
        segments ??= planMontage(chosenId, montageCandidates, dur);
        segments ??= planMontage(chosenId, montageCandidates, dur, MONTAGE_DIVERSITY_RELAXED);
        segments ??= planSameSourceMontage(chosenId, montageCandidates, dur);
      }
      if (segments) montageCount += 1;
      await db.applyBeatSelection(beat.id, ranked, chosenId, segments);
      // Queue the plan for media-fit verification (doc 23 §6). Same-source plans are
      // skipped — one already-τ-approved asset, nothing new to check.
      if (segments && new Set(segments.map((s) => s.candidateId)).size > 1) {
        const thumbById = new Map(
          (candidatesByBeat[i] ?? []).flatMap((c) =>
            c.thumb_path ? [[c.id, c.thumb_path] as const] : [],
          ),
        );
        toVerify.push({
          beatId: beat.id,
          segments,
          moments,
          fallbackPhrase: beat.visual_description ?? beat.text,
          thumbById,
        });
      }
      const top = ranked[0];
      selectionLog.push({
        beatIdx: beat.idx,
        chosen: chosenId,
        rungUsed: rung,
        weak,
        topScore: top ? Number(top.score.toFixed(4)) : null,
        candidateCount: ranked.length,
        scores: ranked.slice(0, 8).map((r) => {
          const base: {
            id: string;
            score: number;
            rank: number;
            ocr?: string;
            identity?: string;
            vlm?: string;
          } = { id: r.id, score: Number(r.score.toFixed(4)), rank: r.rank };
          const ocrReason = ocrReasonById.get(r.id); // OCR watermark/coverage note (doc 25 §5)
          if (ocrReason) base.ocr = ocrReason;
          const identityReason = identityReasonById.get(r.id); // identity veto/penalty note (doc 25 §6)
          if (identityReason) base.identity = identityReason;
          const vlmReason = vlmReasonById.get(r.id); // VLM checklist veto/penalty note (doc 25 §5-D)
          if (vlmReason) base.vlm = vlmReason;
          return base;
        }),
      });
      report(
        55 + Math.round((40 * (i + 1)) / beats.length),
        JSON.stringify({ op: 'select', beat: i + 1, of: beats.length }),
      );
    }

    // Media-fit verification (doc 23 §6): show each planned shot's thumbnail to the
    // vision model with the exact phrase it should depict; clear misfits are pruned
    // (<2 survivors ⇒ the beat renders its chosen single visual). Accept-on-error —
    // verification may never break a render.
    let verifiedItems = 0;
    let misfitsDropped = 0;
    const flat: FitItem[] = [];
    const spans: { start: number; count: number }[] = [];
    for (const v of toVerify) {
      spans.push({ start: flat.length, count: v.segments.length });
      for (const seg of v.segments) {
        flat.push({
          thumbPath: v.thumbById.get(seg.candidateId) ?? '',
          phrase:
            seg.momentIdx !== undefined
              ? (v.moments[seg.momentIdx] ?? v.fallbackPhrase)
              : v.fallbackPhrase,
        });
      }
    }
    if (flat.length > 0) {
      report(96, JSON.stringify({ op: 'verify', done: 0, total: flat.length }));
      const fits = await verifyMediaFit(flat, ctx.log, ctx.signal);
      verifiedItems = flat.length;
      for (let vi = 0; vi < toVerify.length; vi += 1) {
        const v = toVerify[vi];
        const span = spans[vi];
        if (!v || !span) continue;
        const kept = v.segments.filter((_, j) => fits[span.start + j] !== false);
        if (kept.length === v.segments.length) continue;
        misfitsDropped += v.segments.length - kept.length;
        const newPlan = kept.length >= 2 ? kept : null;
        if (!newPlan) montageCount -= 1;
        await db.setBeatSegments(v.beatId, newPlan);
      }
      report(99, JSON.stringify({ op: 'verify', done: flat.length, total: flat.length }));
    }

    const scoreDir = join(paths.projectDir(ctx.projectId), 'stages', 'score');
    await mkdir(scoreDir, { recursive: true });
    await writeFile(
      join(scoreDir, 'selection.json'),
      JSON.stringify(selectionLog, null, 2),
      'utf8',
    );

    report(100, `${chosenCount}/${beats.length} beats resolved`);
    ctx.log.info(
      {
        beats: beats.length,
        resolved: chosenCount,
        weak: weakCount,
        montage: montageCount,
        rungs: rungCounts, // primary / broaden / conceptual / mood / generated / textcard split
      },
      'score/selection',
    );
    return {
      artifacts: ['stages/score/selection.json'],
      warnings,
      meta: {
        beats: beats.length,
        chosen: chosenCount,
        weak: weakCount,
        montage: montageCount,
        verified: verifiedItems,
        misfitsDropped,
        rungs: rungCounts,
        thumbsEmbedded: thumbEmbeddings.size,
        thumbsFailed: failedThumbs.size,
        ocrPenalized, // candidates docked for a watermark / text overlay (doc 25 §5)
        ocrVetoed, // candidates dropped for era contradiction / full overlay (doc 25 §5)
        ocrSkipped, // true ⇒ Tesseract unavailable, gate skipped (degrade path)
        identityPenalized, // candidates docked for a landmark/artwork reference mismatch (doc 25 §6)
        identityVetoed, // candidates dropped as a lookalike person (doc 25 §6)
        identitySkipped, // true ⇒ identity models unavailable, gate skipped (degrade path)
        vlmPenalized, // candidates docked for a VLM era / shot-framing miss (doc 25 §5-D)
        vlmVetoed, // candidates dropped for no subject / contradicting text (doc 25 §5-D)
        vlmSkipped, // true ⇒ VLM model unavailable, gate skipped (degrade path)
        dim: descRes.dim,
      },
    };
  },
};
