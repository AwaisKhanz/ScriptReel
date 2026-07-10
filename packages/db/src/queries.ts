import {
  defaultSettings,
  type PipelineStage,
  type ProjectSettings,
  settingsHash,
} from '@scriptreel/core';
import { sql } from './client';
import type { Database } from './types';

type ProjectRow = Database['public']['Tables']['projects']['Row'];
type PipelineRunRow = Database['public']['Tables']['pipeline_runs']['Row'];
export type BeatRow = Database['public']['Tables']['beats']['Row'];

type JsonValue = Parameters<typeof sql.json>[0];
export type RunStatus = Database['public']['Enums']['run_status'];
export type ProjectStatus = Database['public']['Enums']['project_status'];

export interface JsonError {
  code: string;
  message: string;
  stage?: string;
  [key: string]: string | undefined; // JSON-serializable bag for sql.json()
}

export interface CreateProjectInput {
  title: string;
  script: string;
  settings?: Partial<ProjectSettings>;
  id?: string;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectRow> {
  const settings = { ...defaultSettings(), ...(input.settings ?? {}) };
  const hash = settingsHash(settings);
  const rows = input.id
    ? await sql<ProjectRow[]>`
        insert into projects (id, title, script, settings, settings_hash)
        values (${input.id}, ${input.title}, ${input.script}, ${sql.json(settings)}, ${hash})
        on conflict (id) do update set title = excluded.title
        returning *`
    : await sql<ProjectRow[]>`
        insert into projects (title, script, settings, settings_hash)
        values (${input.title}, ${input.script}, ${sql.json(settings)}, ${hash})
        returning *`;
  const row = rows[0];
  if (!row) {
    throw new Error('createProject: no row returned');
  }
  return row;
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const rows = await sql<ProjectRow[]>`select * from projects where id = ${id}`;
  return rows[0] ?? null;
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await sql`update projects set status = ${status}, updated_at = now() where id = ${id}`;
}

export async function setProjectError(id: string, error: JsonError): Promise<void> {
  await sql`
    update projects set status = 'failed', error = ${sql.json(error)}, updated_at = now()
    where id = ${id}`;
}

export async function requestCancel(id: string): Promise<void> {
  await sql`update projects set cancel_requested = true, updated_at = now() where id = ${id}`;
}

export async function clearCancel(id: string): Promise<void> {
  await sql`update projects set cancel_requested = false, updated_at = now() where id = ${id}`;
}

export async function isCancelRequested(id: string): Promise<boolean> {
  const rows = await sql<{ cancel_requested: boolean }[]>`
    select cancel_requested from projects where id = ${id}`;
  return rows[0]?.cancel_requested ?? false;
}

// Ensure a pending pipeline_runs row exists for every stage (idempotent).
export async function ensurePipelineRuns(
  projectId: string,
  stages: readonly PipelineStage[],
): Promise<void> {
  for (const stage of stages) {
    await sql`
      insert into pipeline_runs (project_id, stage, status, progress)
      values (${projectId}, ${stage}, 'pending', 0)
      on conflict (project_id, stage) do nothing`;
  }
}

export async function markRunRunning(projectId: string, stage: PipelineStage): Promise<void> {
  await sql`
    update pipeline_runs
    set status = 'running', progress = 0, detail = null, error = null,
        attempt = attempt + 1, started_at = now(), finished_at = null
    where project_id = ${projectId} and stage = ${stage}`;
}

export async function markRunProgress(
  projectId: string,
  stage: PipelineStage,
  progress: number,
  detail?: string,
): Promise<void> {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  await sql`
    update pipeline_runs set progress = ${pct}, detail = ${detail ?? null}
    where project_id = ${projectId} and stage = ${stage}`;
}

export async function markRunDone(projectId: string, stage: PipelineStage): Promise<void> {
  await sql`
    update pipeline_runs set status = 'done', progress = 100, finished_at = now()
    where project_id = ${projectId} and stage = ${stage}`;
}

export async function markRunSkipped(projectId: string, stage: PipelineStage): Promise<void> {
  await sql`
    update pipeline_runs set status = 'skipped', progress = 100, finished_at = now()
    where project_id = ${projectId} and stage = ${stage}`;
}

export async function markRunFailed(
  projectId: string,
  stage: PipelineStage,
  error: JsonError,
): Promise<void> {
  await sql`
    update pipeline_runs set status = 'failed', error = ${sql.json(error)}, finished_at = now()
    where project_id = ${projectId} and stage = ${stage}`;
}

export async function getPipelineRuns(
  projectId: string,
): Promise<Pick<PipelineRunRow, 'stage' | 'status' | 'progress'>[]> {
  const rows = await sql<Pick<PipelineRunRow, 'stage' | 'status' | 'progress'>[]>`
    select stage, status, progress from pipeline_runs where project_id = ${projectId}`;
  return [...rows];
}

export async function setProjectLanguage(id: string, language: string): Promise<void> {
  await sql`update projects set language = ${language}, updated_at = now() where id = ${id}`;
}

export interface BeatInsert {
  idx: number;
  text: string;
  visualDescription: string;
  keyPhrase: string;
  emotion: string;
  shotType: string;
  entities: { people: string[]; places: string[]; objects: string[] };
  queries: { literal: string[]; conceptual: string; mood: string };
  estSeconds: number;
}

// Replace all beats for a project in one transaction (analyze re-runs are idempotent).
export async function replaceBeats(projectId: string, beats: readonly BeatInsert[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from beats where project_id = ${projectId}`;
    for (const b of beats) {
      await tx`
        insert into beats
          (project_id, idx, text, visual_description, key_phrase, emotion, shot_type, entities, queries, est_seconds)
        values
          (${projectId}, ${b.idx}, ${b.text}, ${b.visualDescription}, ${b.keyPhrase}, ${b.emotion},
           ${b.shotType}, ${tx.json(b.entities as JsonValue)}, ${tx.json(b.queries as JsonValue)}, ${b.estSeconds})`;
    }
  });
}

export async function getBeats(projectId: string): Promise<BeatRow[]> {
  const rows = await sql<BeatRow[]>`
    select * from beats where project_id = ${projectId} order by idx`;
  return [...rows];
}

export async function setBeatNarration(
  beatId: string,
  narration: { audioPath: string; durationSec: number; startSec: number },
): Promise<void> {
  await sql`update beats set narration = ${sql.json(narration as JsonValue)} where id = ${beatId}`;
}

// Atomically reserve one request in a window, only if under budget (doc 08 §QuotaGuard).
// Returns the new count, or null if already at budget.
export async function reserveQuota(
  provider: string,
  windowStart: Date,
  budget: number,
): Promise<number | null> {
  const rows = await sql<{ requests: number }[]>`
    insert into provider_usage (provider, window_start, requests)
    values (${provider}, ${windowStart}, 1)
    on conflict (provider, window_start) do update set requests = provider_usage.requests + 1
      where provider_usage.requests < ${budget}
    returning requests`;
  return rows[0]?.requests ?? null;
}

export async function getProviderUsage(provider: string, windowStart: Date): Promise<number> {
  const rows = await sql<{ requests: number }[]>`
    select requests from provider_usage where provider = ${provider} and window_start = ${windowStart}`;
  return rows[0]?.requests ?? 0;
}

export type CandidateRow = Database['public']['Tables']['candidates']['Row'];

export interface CandidateInsert {
  beatId: string;
  provider: string;
  providerId: string;
  kind: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbPath?: string;
  remoteUrl?: string;
  pageUrl?: string;
  author?: string;
  license?: string;
  score?: number;
  rank?: number;
  meta?: unknown;
}

export async function replaceCandidatesForBeat(
  beatId: string,
  candidates: readonly CandidateInsert[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from candidates where beat_id = ${beatId}`;
    for (const c of candidates) {
      await tx`
        insert into candidates
          (beat_id, provider, provider_id, kind, width, height, duration, thumb_path,
           remote_url, page_url, author, license, score, rank, meta)
        values
          (${beatId}, ${c.provider}, ${c.providerId}, ${c.kind}, ${c.width ?? null},
           ${c.height ?? null}, ${c.duration ?? null}, ${c.thumbPath ?? null}, ${c.remoteUrl ?? null},
           ${c.pageUrl ?? null}, ${c.author ?? null}, ${c.license ?? null}, ${c.score ?? null},
           ${c.rank ?? null}, ${tx.json((c.meta ?? null) as JsonValue)})
        on conflict (beat_id, provider, provider_id) do nothing`;
    }
  });
}

export async function getCandidatesForBeat(beatId: string): Promise<CandidateRow[]> {
  const rows = await sql<CandidateRow[]>`
    select * from candidates where beat_id = ${beatId} order by rank nulls last, id`;
  return [...rows];
}

// Persist the score stage's result for one beat (doc 09): each candidate's rank +
// score, then the chosen asset (null when the ladder must take over — Phase 7).
export async function applyBeatSelection(
  beatId: string,
  ranked: readonly { id: string; score: number; rank: number }[],
  chosenCandidateId: string | null,
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const r of ranked) {
      await tx`update candidates set score = ${r.score}, rank = ${r.rank} where id = ${r.id}`;
    }
    await tx`update beats set chosen_candidate_id = ${chosenCandidateId} where id = ${beatId}`;
  });
}
