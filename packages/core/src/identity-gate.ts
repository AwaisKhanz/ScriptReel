import {
  IDENTITY_DINO_CATEGORIES,
  IDENTITY_DINO_TAU,
  IDENTITY_FACE_CATEGORIES,
  IDENTITY_FACE_TAU,
  IDENTITY_MISMATCH_PENALTY,
} from './constants';

// The reference-identity gate (doc 25 §5-C, cascade C) — pure decision logic, zero I/O
// (invariant 8). The sidecar embeds an entity's Wikidata reference image and a beat's
// candidate thumbs with a local model; this turns a candidate↔reference cosine into a
// verdict. A person that clearly isn't the named subject (a lookalike) is VETOED; a
// landmark / building / artwork that doesn't match is PENALIZED (softer — DINOv2 image
// similarity is noisier than face identity, so we down-rank rather than drop).

// Which local model verifies a category. Person identity uses face embeddings (strict,
// veto); landmark/building/artwork use whole-image embeddings (soft, penalty). Every
// other category has no reference-identity check → null (the gate skips it).
export type IdentityMethod = 'face' | 'dino';

export function identityMethodFor(category: string): IdentityMethod | null {
  if (IDENTITY_FACE_CATEGORIES.includes(category)) return 'face';
  if (IDENTITY_DINO_CATEGORIES.includes(category)) return 'dino';
  return null;
}

export interface IdentityVerdict {
  veto: boolean; // true ⇒ drop the candidate before selection sees it (person mismatch)
  penalty: number; // subtracted un-multiplied in rankBeat; 0 when clean or vetoed
  reason: string; // compact human string for the selection log; '' when clean
}

const CLEAN: IdentityVerdict = { veto: false, penalty: 0, reason: '' };

// Score one candidate's similarity to the entity's reference image. `sim` is the
// model-specific cosine (InsightFace for 'face', DINOv2 for 'dino'). Below the method's
// τ the candidate isn't the named entity: a face mismatch is a lookalike → veto; a
// landmark/artwork mismatch is down-ranked → penalty (a clean alternative wins, but a
// noisier signal never drops the only decent asset a beat has).
export function identityGate(sim: number, method: IdentityMethod): IdentityVerdict {
  if (method === 'face') {
    if (sim < IDENTITY_FACE_TAU) {
      return { veto: true, penalty: 0, reason: `identity:face-${sim.toFixed(2)}` };
    }
    return CLEAN;
  }
  if (sim < IDENTITY_DINO_TAU) {
    return {
      veto: false,
      penalty: IDENTITY_MISMATCH_PENALTY,
      reason: `identity:dino-${sim.toFixed(2)}`,
    };
  }
  return CLEAN;
}
