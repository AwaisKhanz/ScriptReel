import { z } from 'zod';

// The seven pipeline stages, in order (doc 06). `as const` union, never an enum (doc 18).
export const STAGES = ['analyze', 'search', 'score', 'tts', 'align', 'fetch', 'compose'] as const;
export type PipelineStage = (typeof STAGES)[number];

export const PIPELINE_QUEUE = 'pipeline' as const;

// Job payload mode (doc 06 §Job model).
export type JobMode = 'full' | 'continue' | 'composeOnly' | `stage:${PipelineStage}`;

export function isJobMode(value: string): value is JobMode {
  return (
    value === 'full' ||
    value === 'continue' ||
    value === 'composeOnly' ||
    STAGES.some((stage) => value === `stage:${stage}`)
  );
}

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a uuid');

// Parsed at the pg-boss handler boundary (doc 18: zod at every process boundary).
export const PipelinePayloadSchema = z.object({
  projectId: uuid,
  mode: z.custom<JobMode>((v) => typeof v === 'string' && isJobMode(v), 'invalid job mode'),
});
export type PipelinePayload = z.infer<typeof PipelinePayloadSchema>;

// The storyboard's single-beat re-search (BEAT_RESEARCH_QUEUE / BeatResearchPayload) was removed
// 2026-07-17: the selector picks, and there is no manual override to enqueue work for. It ranked on
// different rules than score did anyway (bare baseScore, no authority bonus, no OCR/identity/VLM
// penalties) and silently nulled a beat's montage plan on every run.
