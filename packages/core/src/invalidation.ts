import type { PipelineStage } from './jobs';
import { STAGES } from './jobs';
import type { ProjectSettings } from './settings';

// The stage dependency graph (doc 06 §Inputs → hash map). Each stage lists the
// stages that consume its manifest, so invalidating a stage transitively
// invalidates everything downstream of it.
const DOWNSTREAM: Record<PipelineStage, PipelineStage[]> = {
  analyze: ['search', 'tts'],
  search: ['score'],
  score: ['fetch'],
  tts: ['align'],
  align: ['compose'],
  fetch: ['compose'],
  compose: [],
};

// Which stage(s) each settings field feeds *directly* (doc 06). Downstream stages
// are derived from DOWNSTREAM, never hardcoded, so the graph stays the single source.
const DIRECT: Record<keyof ProjectSettings, PipelineStage[]> = {
  // analyze inputs (script, language, pacing)
  pacing: ['analyze'],
  language: ['analyze', 'align'], // language override → analyze; subtitle language → align
  // narration
  voice: ['tts'],
  // speed also drives estimateSeconds → est_seconds → the analyze post-pass merge/split
  // boundaries, so it reshapes the beats themselves and not only their timing.
  speed: ['analyze', 'tts'],
  pauseMs: ['tts'],
  // orientation / format
  aspect: ['search', 'score', 'fetch', 'compose'],
  mediaPreference: ['search', 'score'],
  allowGenerated: ['score'],
  // timeline-affecting → compose only
  quality: ['compose'],
  transitionStyle: ['compose'],
  crossfadeSec: ['compose'],
  subtitlePreset: ['compose'],
  subtitlePosition: ['compose'],
  musicMood: ['compose'],
  musicTrackId: ['compose'],
  musicLevelDb: ['compose'],
  // pure gate behaviour — invalidates nothing
  reviewBeforeRender: [],
};

function closure(seed: Iterable<PipelineStage>): Set<PipelineStage> {
  const out = new Set<PipelineStage>();
  const queue = [...seed];
  while (queue.length > 0) {
    const stage = queue.shift();
    if (stage === undefined || out.has(stage)) continue;
    out.add(stage);
    for (const next of DOWNSTREAM[stage]) queue.push(next);
  }
  return out;
}

function ordered(stages: Set<PipelineStage>): PipelineStage[] {
  return STAGES.filter((s) => stages.has(s));
}

// Changing a script text nukes the whole chain (analyze rebuilds everything).
export function invalidatedByScript(): PipelineStage[] {
  return ordered(closure(['analyze']));
}

// The stages that must re-run given a settings patch, in pipeline order. Pure —
// the rerender API and the UI's dry-run preview call this so they can never
// disagree (doc 12 exit criterion: "the invalidation preview never lies").
export function invalidatedStages(
  patch: Partial<ProjectSettings>,
  current: Partial<ProjectSettings>,
): PipelineStage[] {
  const seed = new Set<PipelineStage>();
  for (const key of Object.keys(patch) as (keyof ProjectSettings)[]) {
    if (patch[key] === undefined) continue;
    if (patch[key] === current[key]) continue;
    for (const stage of DIRECT[key]) seed.add(stage);
  }
  return ordered(closure(seed));
}

// The narrowest pg-boss mode that re-runs the invalidated stages (doc 15): if
// anything before `compose` is invalid we need a `full` walk (manifests skip the
// survivors); a compose-only change runs `composeOnly`.
export function narrowestMode(invalidated: PipelineStage[]): 'full' | 'composeOnly' {
  return invalidated.some((s) => s !== 'compose') ? 'full' : 'composeOnly';
}
