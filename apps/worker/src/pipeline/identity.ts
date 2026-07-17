import { join } from 'node:path';
import {
  cosine,
  type Entity,
  type IdentityMethod,
  identityGate,
  identityMethodFor,
  namesSubject,
  PipelineError,
  parseEntities,
  type SelectionBeat,
  type SelectionCandidate,
} from '@scriptreel/core';
import type * as db from '@scriptreel/db';
import type { Logger } from 'pino';
import { resolveReferenceImage } from '../analysis/knowledge';
import { cacheImageTo } from '../providers/thumbs';
import { dinoEmbed, type EmbedImageResult, faceEmbed } from '../sidecar/client';

// Reference-identity gate (doc 25 §5-C, cascade C). For a beat that names a specific
// person / landmark / artwork, compare its SigLIP top-5 shortlist to the entity's
// Wikidata reference image with a LOCAL model and drop / down-rank candidates that
// aren't that entity: person → InsightFace face cosine (veto a lookalike);
// landmark / building / artwork → DINOv2 image cosine (penalize a mismatch).
//
// DEGRADE, NEVER DIE (invariant 7): the identity models are OPTIONAL and NOT installed
// by default. If faceEmbed / dinoEmbed throws for ANY reason (model absent, sidecar
// down, timeout) the ENTIRE gate is skipped — no vetoes, no penalties, selection
// unchanged, ONE warning. Two mechanisms enforce this:
//   1. Short-circuit: the FIRST embed throw breaks the beat loop, so we stop resolving
//      Wikidata references we can't use (an E_*_UNAVAILABLE also sets `unavailable`).
//   2. Accumulate-then-commit: verdicts are gathered per beat and only applied if the
//      whole pass finishes WITHOUT an embed throw — so even a mid-pass failure returns
//      the original selection untouched. An outer try/catch is the final backstop.

const REF_DIR = 'references';

export interface IdentityGateResult {
  selectionBeats: SelectionBeat[];
  penalized: number; // candidates docked an identityPenalty (landmark/artwork mismatch)
  vetoed: number; // candidates dropped (person lookalike)
  skipped: boolean; // true ⇒ models unavailable / error, gate skipped (degrade path)
  reasons: Map<string, string>; // candidate id → identity reason, for the selection log
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'ref'
  );
}

// The first visualizable entity on a beat that has a reference-identity method (doc 25
// §5-C): person → face, landmark/building/artwork → dino. None ⇒ the gate skips the beat.
function pickIdentityEntity(
  entities: readonly Entity[],
): { entity: Entity; method: IdentityMethod } | null {
  for (const entity of entities) {
    if (!entity.visualizable) continue;
    const method = identityMethodFor(entity.category);
    if (method) return { entity, method };
  }
  return null;
}

export async function applyIdentityGate(args: {
  selectionBeats: SelectionBeat[];
  beats: readonly db.BeatRow[];
  thumbByCandidate: Map<string, string>; // candidate id → primary thumb path
  shortlistIdsByBeat: string[][]; // reuse the OCR top-5-by-sim shortlist
  cacheDir: string; // paths.cacheDir
  log: Logger;
  signal: AbortSignal;
}): Promise<IdentityGateResult> {
  const { selectionBeats, beats, thumbByCandidate, shortlistIdsByBeat, cacheDir, log, signal } =
    args;

  // The degrade result: original selection, nothing applied, marked skipped, no reasons.
  const unchanged = (): IdentityGateResult => ({
    selectionBeats,
    penalized: 0,
    vetoed: 0,
    skipped: true,
    reasons: new Map(),
  });

  try {
    const refByCanonical = new Map<string, string | null>(); // canonical → ref path | null (memoized)
    const refEmbByPath = new Map<string, number[]>(); // ref path → embedding ([] = unusable, memoized)
    const reasons = new Map<string, string>();
    const vetoedByBeat = selectionBeats.map(() => new Set<string>());
    const penaltyByBeat = selectionBeats.map(() => new Map<string, number>());

    let unavailable = false; // an E_*_UNAVAILABLE surfaced — the model isn't installed
    let embedThrew = false; // ANY embed threw — degrade the whole gate
    let warned = false;
    const warnOnce = (err: unknown): void => {
      if (warned) return;
      warned = true;
      log.warn({ err }, 'identity gate skipped — continuing without reference-identity filtering');
    };

    for (let i = 0; i < selectionBeats.length; i += 1) {
      if (unavailable || embedThrew) break; // no wasted Wikidata calls after a failure
      const beat = beats[i];
      if (!beat) continue;
      const entities = parseEntities(beat.entities);
      if (!namesSubject(entities)) continue; // no specific subject → nothing to verify

      const picked = pickIdentityEntity(entities);
      if (!picked) continue;
      const { entity, method } = picked;

      // Reference image, memoized per canonical (resolve Wikidata + download once).
      const key = entity.canonical.toLowerCase();
      let refPath = refByCanonical.get(key) ?? null;
      if (!refByCanonical.has(key)) {
        const url = await resolveReferenceImage(entity.canonical, entity.instanceOf);
        refPath = url
          ? await cacheImageTo(
              url,
              join(cacheDir, REF_DIR, `${slug(entity.canonical)}.jpg`),
              signal,
            )
          : null;
        refByCanonical.set(key, refPath);
      }
      if (!refPath) continue; // no reference → can't verify this beat

      // Reference embedding, memoized per ref path. The FIRST embed here is what surfaces
      // a missing model → E_*_UNAVAILABLE → short-circuit the whole pass.
      let refEmb = refEmbByPath.get(refPath);
      if (refEmb === undefined) {
        let res: EmbedImageResult;
        try {
          res =
            method === 'face'
              ? await faceEmbed([refPath], signal)
              : await dinoEmbed([refPath], signal);
        } catch (err) {
          // A cancel is not a missing model — see the note in pipeline/vlm.ts.
          if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
          embedThrew = true;
          if (err instanceof Error && err.message.includes('UNAVAILABLE')) unavailable = true;
          warnOnce(err);
          break;
        }
        const vec = res.failed.includes(refPath) ? undefined : res.vectors[0];
        refEmb = vec && vec.length > 0 ? vec : []; // [] ⇒ no face in portrait / unreadable ref
        refEmbByPath.set(refPath, refEmb);
      }
      if (refEmb.length === 0) continue; // no usable reference embedding → skip beat

      // Candidate thumbs from the beat's SigLIP shortlist.
      const idThumbs: { id: string; thumb: string }[] = [];
      for (const id of shortlistIdsByBeat[i] ?? []) {
        const thumb = thumbByCandidate.get(id);
        if (thumb) idThumbs.push({ id, thumb });
      }
      if (idThumbs.length === 0) continue;
      const thumbs = [...new Set(idThumbs.map((t) => t.thumb))];

      let candRes: EmbedImageResult;
      try {
        candRes =
          method === 'face' ? await faceEmbed(thumbs, signal) : await dinoEmbed(thumbs, signal);
      } catch (err) {
        // A cancel is not a missing model — see the note in pipeline/vlm.ts.
        if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
        embedThrew = true;
        if (err instanceof Error && err.message.includes('UNAVAILABLE')) unavailable = true;
        warnOnce(err);
        break;
      }
      const embByThumb = new Map<string, number[]>();
      thumbs.forEach((thumb, j) => {
        if (candRes.failed.includes(thumb)) return;
        const vec = candRes.vectors[j];
        if (vec && vec.length > 0) embByThumb.set(thumb, vec);
      });

      // Verdicts: candidate↔reference cosine → veto (face) / penalty (dino) / clean.
      for (const { id, thumb } of idThumbs) {
        const candEmb = embByThumb.get(thumb);
        if (!candEmb) continue; // embedding failed for this candidate → no verdict
        const verdict = identityGate(cosine(refEmb, candEmb), method);
        if (verdict.reason) reasons.set(id, verdict.reason);
        if (verdict.veto) vetoedByBeat[i]?.add(id);
        else if (verdict.penalty > 0) penaltyByBeat[i]?.set(id, verdict.penalty);
      }
    }

    // Any embed failure ⇒ degrade: selection unchanged (invariant 7).
    if (embedThrew) return unchanged();

    // Commit accumulated verdicts immutably (like the OCR gate): drop vetoed ids, attach
    // identityPenalty to penalized, pass the rest through. Untouched beats keep their ref.
    let penalized = 0;
    let vetoed = 0;
    const next = selectionBeats.map((sb, i) => {
      const drop = vetoedByBeat[i];
      const pen = penaltyByBeat[i];
      if (!drop || !pen || (drop.size === 0 && pen.size === 0)) return sb;
      const candidates: SelectionCandidate[] = [];
      for (const c of sb.candidates) {
        if (drop.has(c.id)) {
          vetoed += 1;
          continue; // removed from the pool selectBeats sees
        }
        const p = pen.get(c.id);
        if (p !== undefined) {
          penalized += 1;
          candidates.push({ ...c, identityPenalty: p });
        } else {
          candidates.push(c);
        }
      }
      return { ...sb, candidates };
    });

    return { selectionBeats: next, penalized, vetoed, skipped: false, reasons };
  } catch (err) {
    // A cancel is not a missing capability — see the note in pipeline/vlm.ts. Swallowing it
    // here writes `identitySkipped: true` into a manifest that is never re-computed.
    if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
    // Belt-and-suspenders: any unexpected throw leaves selection exactly as it was.
    log.warn({ err }, 'identity gate skipped — unexpected error, selection unchanged');
    return unchanged();
  }
}
