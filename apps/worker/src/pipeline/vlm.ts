import {
  type Entity,
  PipelineError,
  parseEntities,
  type SelectionBeat,
  type SelectionCandidate,
  VLM_TOP_K,
  type VlmChecklist,
  vlmGate,
  vlmNeeded,
} from '@scriptreel/core';
import type * as db from '@scriptreel/db';
import type { Logger } from 'pino';
import { type VlmItem, vlm } from '../sidecar/client';

// VLM checklist gate (doc 25 §5-D, cascade D). After the OCR + reference-identity gates,
// run Qwen2.5-VL on each beat's top-VLM_TOP_K candidates (by SigLIP sim) and ask a strict
// four-bool checklist — subject present? shot framing appropriate? era matches? any
// contradicting on-screen text? — so the survivor is VLM-confirmed. A no-subject or
// contradicting-text candidate is VETOED (dropped); an era / shot-framing miss is
// PENALIZED (down-ranked). ADAPTIVE SKIP: a beat with NO named entity AND a strong SigLIP
// margin skips the VLM entirely — a clear generic win needs no VLM call.
//
// DEGRADE, NEVER DIE (invariant 7): the VLM model + mlx-vlm are OPTIONAL and NOT installed
// by default. This is ONE batched /vlm call; if it throws for ANY reason (model absent,
// sidecar down, timeout) the ENTIRE pass skips — no vetoes, no penalties, selection
// unchanged, ONE warning. Two mechanisms enforce this, mirroring the identity gate:
//   1. Short-circuit: the single try/catch around the one /vlm call — a throw returns
//      the ORIGINAL selection before any verdict is computed.
//   2. Accumulate-then-commit: verdicts are gathered per beat and applied only after the
//      call succeeds, so a mid-parse issue can't partially apply. An outer try/catch is
//      the final backstop.

export interface VlmGateResult {
  selectionBeats: SelectionBeat[];
  penalized: number; // candidates docked a vlmPenalty (era / shot-framing miss)
  vetoed: number; // candidates dropped (no subject / contradicting text)
  skipped: boolean; // true ⇒ model unavailable / error, gate skipped (degrade path)
  reasons: Map<string, string>; // candidate id → VLM reason, for the selection log
}

// The first visualizable, named entity on a beat — used to prefix the checklist
// description so the VLM knows the specific subject to look for. null ⇒ a generic beat.
function firstVisualizableEntity(entities: readonly Entity[]): Entity | null {
  for (const entity of entities) {
    if (entity.visualizable && entity.canonical.length > 0) return entity;
  }
  return null;
}

export async function applyVlmGate(args: {
  selectionBeats: SelectionBeat[];
  beats: readonly db.BeatRow[];
  thumbByCandidate: Map<string, string>; // candidate id → primary thumb path
  cacheDir: string; // paths.cacheDir (parity with the identity gate; unused here)
  log: Logger;
  signal: AbortSignal;
}): Promise<VlmGateResult> {
  const { selectionBeats, beats, thumbByCandidate, log, signal } = args;

  // The degrade result: original selection, nothing applied, marked skipped, no reasons.
  const unchanged = (): VlmGateResult => ({
    selectionBeats,
    penalized: 0,
    vetoed: 0,
    skipped: true,
    reasons: new Map(),
  });

  try {
    // 1) Decide which candidates need the VLM. For each beat: skip entirely when it has
    //    no named entity AND a strong SigLIP margin (adaptive skip); otherwise take the
    //    top-VLM_TOP_K by sim. Build ONE deduped item list (keyed by thumb path) and,
    //    per beat, track which candidate id each path maps to.
    const itemByPath = new Map<string, VlmItem>(); // dedupe the batch by image path
    const trackedByBeat: { id: string; path: string }[][] = selectionBeats.map(() => []);

    for (let i = 0; i < selectionBeats.length; i += 1) {
      const sc = selectionBeats[i];
      const beat = beats[i];
      if (!sc || !beat) continue;

      const entities = parseEntities(beat.entities);
      const hasEntity = entities.some((e) => e.visualizable);

      const sorted = [...sc.candidates].sort((a, b) => b.sim - a.sim);
      // Single-candidate (or empty) beat ⇒ an effectively infinite margin (nothing to
      // discriminate) so a no-entity beat skips.
      const simMargin =
        sorted.length >= 2
          ? (sorted[0]?.sim ?? 0) - (sorted[1]?.sim ?? 0)
          : Number.POSITIVE_INFINITY;
      if (!vlmNeeded(hasEntity, simMargin)) continue;

      const named = firstVisualizableEntity(entities);
      const desc = beat.visual_description ?? beat.text;
      const description = named ? `${named.canonical} — ${desc}` : desc;
      const era = beat.era ?? 'timeless';

      for (const c of sorted.slice(0, VLM_TOP_K)) {
        const path = thumbByCandidate.get(c.id);
        if (!path) continue;
        trackedByBeat[i]?.push({ id: c.id, path });
        if (!itemByPath.has(path)) itemByPath.set(path, { path, description, era });
      }
    }

    const items = [...itemByPath.values()];
    // No candidate needed the VLM (every beat adaptively skipped, or no thumbs) — this is
    // NOT a degrade: selection is unchanged and the gate simply had no work.
    if (items.length === 0) {
      return { selectionBeats, penalized: 0, vetoed: 0, skipped: false, reasons: new Map() };
    }

    // 2) ONE batched /vlm call. A throw here is the short-circuit: return the ORIGINAL
    //    selection, warn once — no verdict was computed, so nothing can partially apply.
    let res: Awaited<ReturnType<typeof vlm>>;
    try {
      res = await vlm(items, signal);
    } catch (err) {
      // A cancel is not a missing capability. postSidecar already tells the two apart; if we
      // swallow E_CANCELLED here the run continues, score writes its manifest with
      // `vlmSkipped: true`, and because gate availability is not part of score's inputsHash
      // every later run reports `skipped (inputsHash match)` — the project then ships
      // unverified selections forever. Same rule as providers/search.ts.
      if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
      log.warn({ err }, 'VLM gate skipped — continuing without VLM checklist verification');
      return unchanged();
    }

    // 3) Map results by path → checklist; images the model couldn't read/parse are in
    //    `failed` (no verdict). Accumulate per-beat veto ids / penalties / reasons.
    const failed = new Set(res.failed);
    const checklistByPath = new Map<string, VlmChecklist>();
    for (const r of res.results) {
      checklistByPath.set(r.path, {
        subjectPresent: r.subjectPresent,
        shotTypeMatches: r.shotTypeMatches,
        eraMatches: r.eraMatches,
        contradictingText: r.contradictingText,
      });
    }

    const reasons = new Map<string, string>();
    const vetoedByBeat = selectionBeats.map(() => new Set<string>());
    const penaltyByBeat = selectionBeats.map(() => new Map<string, number>());
    for (let i = 0; i < selectionBeats.length; i += 1) {
      for (const { id, path } of trackedByBeat[i] ?? []) {
        if (failed.has(path)) continue; // unreadable image → no verdict
        const checklist = checklistByPath.get(path);
        if (!checklist) continue;
        const verdict = vlmGate(checklist);
        if (verdict.reason) reasons.set(id, verdict.reason);
        if (verdict.veto) vetoedByBeat[i]?.add(id);
        else if (verdict.penalty > 0) penaltyByBeat[i]?.set(id, verdict.penalty);
      }
    }

    // 4) Commit accumulated verdicts immutably (like the OCR / identity gates): drop
    //    vetoed ids, attach vlmPenalty to penalized, pass the rest through untouched.
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
          candidates.push({ ...c, vlmPenalty: p });
        } else {
          candidates.push(c);
        }
      }
      return { ...sb, candidates };
    });

    return { selectionBeats: next, penalized, vetoed, skipped: false, reasons };
  } catch (err) {
    // A cancel is not a missing capability. postSidecar already distinguishes the two, but
    // swallowing E_CANCELLED here turns "the user pressed Cancel" into "this gate is
    // unavailable" — and because gate availability is not part of score's inputsHash, that
    // verdict is written to the manifest and every later run reports `skipped (inputsHash
    // match)`. The project would then ship unverified selections forever. Same rule as
    // providers/search.ts.
    if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
    // Belt-and-suspenders: any unexpected throw leaves selection exactly as it was.
    log.warn({ err }, 'VLM gate skipped — unexpected error, selection unchanged');
    return unchanged();
  }
}
