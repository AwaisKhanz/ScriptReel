import { VLM_ERA_PENALTY, VLM_MAX_PENALTY, VLM_SHOT_PENALTY, VLM_SKIP_MARGIN } from './constants';

// The VLM checklist gate (doc 25 §5-D, cascade D) — pure decision logic, zero I/O
// (invariant 8). The sidecar runs Qwen2.5-VL over a beat's SigLIP top-3 and returns a
// four-bool checklist per candidate; this turns that checklist into a verdict. A missing
// subject or contradicting on-screen text VETOES the candidate (it isn't the beat); an
// era mismatch or poor shot framing PENALIZES it (down-ranked, a clean alternative wins).

// One Qwen2.5-VL read of a single candidate image: does it show the subject, is it well
// framed, does the era match, is there contradicting burned-in text?
export interface VlmChecklist {
  subjectPresent: boolean;
  shotTypeMatches: boolean;
  eraMatches: boolean;
  contradictingText: boolean;
}

export interface VlmVerdict {
  veto: boolean; // true ⇒ drop the candidate before selection sees it
  penalty: number; // subtracted un-multiplied in rankBeat; 0 when clean or vetoed
  reason: string; // compact human string for the selection log; '' when clean
}

const CLEAN: VlmVerdict = { veto: false, penalty: 0, reason: '' };

// Turn one checklist into a verdict. Veto is decisive and independent of penalty: no
// subject, or text that contradicts the subject/era, drops the candidate outright. Only
// a candidate that passes both veto checks can be penalized — an era miss and/or a poor
// shot framing dock the score (summed, capped) so a cleaner alternative outranks it.
export function vlmGate(c: VlmChecklist): VlmVerdict {
  if (!c.subjectPresent) return { veto: true, penalty: 0, reason: 'vlm:no-subject' };
  if (c.contradictingText) return { veto: true, penalty: 0, reason: 'vlm:contradicting-text' };

  const parts: string[] = [];
  let penalty = 0;
  if (!c.eraMatches) {
    penalty += VLM_ERA_PENALTY;
    parts.push('era');
  }
  if (!c.shotTypeMatches) {
    penalty += VLM_SHOT_PENALTY;
    parts.push('shot');
  }
  if (penalty === 0) return CLEAN;
  return {
    veto: false,
    penalty: Math.min(penalty, VLM_MAX_PENALTY),
    reason: `vlm:${parts.join('+')}`,
  };
}

// The adaptive skip (doc 25 §5-D): the VLM only runs when it might change the outcome.
// A beat that names a specific entity always runs (lookalikes / wrong-subject risk is
// highest there). A beat with NO named entity skips when its SigLIP margin is strong —
// a clear generic win needs no VLM call. `simMargin` = top1.sim − top2.sim (the caller
// computes it; a single-candidate beat passes a large margin).
export function vlmNeeded(hasEntity: boolean, simMargin: number): boolean {
  return hasEntity || simMargin < VLM_SKIP_MARGIN;
}
