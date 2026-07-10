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
