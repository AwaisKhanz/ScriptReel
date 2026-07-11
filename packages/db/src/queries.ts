import {
  defaultSettings,
  type PipelineStage,
  type ProjectSettings,
  type ProviderCredentials,
  parseSettings,
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

export interface ProjectCardRow {
  id: string;
  title: string;
  status: ProjectStatus;
  updated_at: string;
  duration: number | null;
  thumbnail_path: string | null;
  aspect: string | null;
}

// Dashboard cards (doc 15): projects newest-first, each with its latest render's
// thumbnail + duration (if any).
export async function listProjects(limit = 60): Promise<ProjectCardRow[]> {
  const rows = await sql<ProjectCardRow[]>`
    select p.id, p.title, p.status, p.updated_at, r.duration, r.thumbnail_path, r.aspect
    from projects p
    left join lateral (
      select duration, thumbnail_path, aspect from renders
      where project_id = p.id order by created_at desc limit 1
    ) r on true
    order by p.updated_at desc
    limit ${limit}`;
  return [...rows];
}

export async function getRenders(projectId: string): Promise<RenderRow[]> {
  const rows = await sql<RenderRow[]>`
    select * from renders where project_id = ${projectId} order by created_at desc`;
  return [...rows];
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await sql`update projects set status = ${status}, updated_at = now() where id = ${id}`;
}

// Delete a project row; beats/candidates/pipeline_runs/renders cascade (FK on delete
// cascade, migration 0001). The caller removes DATA_DIR/projects/{id} (doc 15).
export async function deleteProject(id: string): Promise<boolean> {
  const rows = await sql`delete from projects where id = ${id} returning id`;
  return rows.length > 0;
}

// Merge a settings patch over the project's current settings, re-validate, and
// recompute settings_hash (doc 15 PATCH). Stage invalidation is by hash (doc 06).
export async function updateProjectSettings(
  id: string,
  patch: Partial<ProjectSettings>,
): Promise<ProjectRow> {
  const project = await getProject(id);
  if (!project) throw new Error(`updateProjectSettings: project ${id} not found`);
  const merged = parseSettings({ ...(project.settings as object), ...patch });
  const hash = settingsHash(merged);
  const rows = await sql<ProjectRow[]>`
    update projects set settings = ${sql.json(merged)}, settings_hash = ${hash}, updated_at = now()
    where id = ${id} returning *`;
  const row = rows[0];
  if (!row) throw new Error('updateProjectSettings: no row returned');
  return row;
}

export async function updateProjectScript(
  id: string,
  script: string,
  title?: string,
): Promise<void> {
  await sql`update projects set script = ${script}, ${title !== undefined ? sql`title = ${title},` : sql``} updated_at = now() where id = ${id}`;
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

// On cancel: a stage left mid-run reverts to pending so the draft resumes cleanly.
export async function resetRunningRuns(projectId: string): Promise<void> {
  await sql`
    update pipeline_runs set status = 'pending', progress = 0, detail = null
    where project_id = ${projectId} and status = 'running'`;
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

// Sum usage across all pooled keys for a window prefix, e.g. 'pexels:hour' matches
// 'pexels:hour' (env fallback) and 'pexels:hour#<id>' (pooled keys) — doc 23.
export async function getCombinedUsage(budgetKey: string, windowStart: Date): Promise<number> {
  const rows = await sql<{ total: number }[]>`
    select coalesce(sum(requests), 0)::int as total from provider_usage
    where window_start = ${windowStart} and (provider = ${budgetKey} or provider like ${`${budgetKey}#%`})`;
  return rows[0]?.total ?? 0;
}

// ---- Provider key pool (doc 23) ------------------------------------------------
// The `secret` column holds a JSON credentials object ({apiKey} or {clientId,
// clientSecret}), so a provider can need one field or several (doc 23 auth model).
export interface ProviderKeyMeta {
  id: string;
  provider: string;
  label: string | null;
  active: boolean;
  created_at: string;
  creds: ProviderCredentials;
}

function parseCreds(secret: string): ProviderCredentials {
  try {
    const v: unknown = JSON.parse(secret);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as ProviderCredentials;
  } catch {
    // not JSON — treat a legacy raw string as a single apiKey
  }
  return { apiKey: secret };
}

export async function insertProviderKey(input: {
  provider: string;
  credentials: ProviderCredentials;
  label?: string;
}): Promise<ProviderKeyMeta> {
  const rows = await sql<
    { id: string; provider: string; label: string | null; created_at: string }[]
  >`
    insert into provider_keys (provider, label, secret)
    values (${input.provider}, ${input.label ?? null}, ${JSON.stringify(input.credentials)})
    returning id, provider, label, created_at`;
  const row = rows[0];
  if (!row) throw new Error('insertProviderKey: no row returned');
  return { ...row, active: true, creds: input.credentials };
}

// All keys with parsed credentials (never expose raw secrets to callers by default;
// the admin route masks them).
export async function listProviderKeys(): Promise<ProviderKeyMeta[]> {
  const rows = await sql<
    {
      id: string;
      provider: string;
      label: string | null;
      active: boolean;
      created_at: string;
      secret: string;
    }[]
  >`select id, provider, label, active, created_at, secret from provider_keys order by provider, created_at`;
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    active: r.active,
    created_at: r.created_at,
    creds: parseCreds(r.secret),
  }));
}

// Active keys for a provider with parsed credentials, for the QuotaGuard pool.
export async function activeKeysFor(
  provider: string,
): Promise<{ id: string; creds: ProviderCredentials }[]> {
  const rows = await sql<{ id: string; secret: string }[]>`
    select id, secret from provider_keys
    where provider = ${provider} and active = true order by created_at`;
  return rows.map((r) => ({ id: r.id, creds: parseCreds(r.secret) }));
}

export async function deleteProviderKey(id: string): Promise<boolean> {
  const rows = await sql`delete from provider_keys where id = ${id} returning id`;
  return rows.length > 0;
}

export async function setProviderKeyActive(id: string, active: boolean): Promise<void> {
  await sql`update provider_keys set active = ${active} where id = ${id}`;
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

// Append ladder candidates without wiping tier-1 (doc 09). Returns the rows that
// were actually inserted (conflicts on an already-present asset are skipped).
export async function appendCandidatesForBeat(
  beatId: string,
  candidates: readonly CandidateInsert[],
): Promise<CandidateRow[]> {
  const inserted: CandidateRow[] = [];
  for (const c of candidates) {
    const rows = await sql<CandidateRow[]>`
      insert into candidates
        (beat_id, provider, provider_id, kind, width, height, duration, thumb_path,
         remote_url, page_url, author, license, score, rank, meta)
      values
        (${beatId}, ${c.provider}, ${c.providerId}, ${c.kind}, ${c.width ?? null},
         ${c.height ?? null}, ${c.duration ?? null}, ${c.thumbPath ?? null}, ${c.remoteUrl ?? null},
         ${c.pageUrl ?? null}, ${c.author ?? null}, ${c.license ?? null}, ${c.score ?? null},
         ${c.rank ?? null}, ${sql.json((c.meta ?? null) as JsonValue)})
      on conflict (beat_id, provider, provider_id) do nothing
      returning *`;
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

export async function setBeatForcedTextcard(beatId: string, forced: boolean): Promise<void> {
  await sql`update beats set forced_textcard = ${forced} where id = ${beatId}`;
}

export async function setBeatVisualDescription(beatId: string, description: string): Promise<void> {
  await sql`update beats set visual_description = ${description} where id = ${beatId}`;
}

export async function setBeatChosenCandidate(
  beatId: string,
  chosenCandidateId: string | null,
): Promise<void> {
  await sql`update beats set chosen_candidate_id = ${chosenCandidateId} where id = ${beatId}`;
}

// Owning project + its status for a beat — the storyboard PATCH/research routes
// gate on `awaiting_review` (doc 15).
export async function getBeatOwner(
  beatId: string,
): Promise<{ projectId: string; status: ProjectStatus } | null> {
  const rows = await sql<{ projectId: string; status: ProjectStatus }[]>`
    select b.project_id as "projectId", p.status
    from beats b join projects p on p.id = b.project_id
    where b.id = ${beatId}`;
  return rows[0] ?? null;
}

export async function candidateBelongsToBeat(
  beatId: string,
  candidateId: string,
): Promise<boolean> {
  const rows = await sql`
    select 1 from candidates where id = ${candidateId} and beat_id = ${beatId} limit 1`;
  return rows.length > 0;
}

// Beats + their top-8 candidates by rank, for the storyboard (doc 16). One query
// for all candidates, grouped in memory (avoids N+1 across beats).
export async function getStoryboard(
  projectId: string,
): Promise<{ beat: BeatRow; candidates: CandidateRow[] }[]> {
  const beats = await getBeats(projectId);
  if (beats.length === 0) return [];
  const ids = beats.map((b) => b.id);
  const cands = await sql<CandidateRow[]>`
    select * from candidates where beat_id = any(${ids}) order by rank nulls last, id`;
  const byBeat = new Map<string, CandidateRow[]>();
  for (const c of cands) {
    const arr = byBeat.get(c.beat_id);
    if (arr) arr.push(c);
    else byBeat.set(c.beat_id, [c]);
  }
  return beats.map((beat) => ({ beat, candidates: (byBeat.get(beat.id) ?? []).slice(0, 8) }));
}

export type AssetCacheRow = Database['public']['Tables']['asset_cache']['Row'];

export interface AssetCacheInsert {
  provider: string;
  providerId: string;
  kind: string;
  localPath: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  license?: string;
  author?: string;
  pageUrl?: string;
  checksum?: string;
}

// Shared downloaded originals (doc 05, doc 08). Keyed by (provider, provider_id, kind)
// so the same asset is fetched once across projects.
export async function getCachedAsset(
  provider: string,
  providerId: string,
  kind: string,
): Promise<AssetCacheRow | null> {
  const rows = await sql<AssetCacheRow[]>`
    select * from asset_cache
    where provider = ${provider} and provider_id = ${providerId} and kind = ${kind}`;
  return rows[0] ?? null;
}

export async function upsertCachedAsset(a: AssetCacheInsert): Promise<AssetCacheRow> {
  const rows = await sql<AssetCacheRow[]>`
    insert into asset_cache
      (provider, provider_id, kind, local_path, bytes, width, height, duration,
       license, author, page_url, checksum, last_used_at)
    values
      (${a.provider}, ${a.providerId}, ${a.kind}, ${a.localPath}, ${a.bytes ?? null},
       ${a.width ?? null}, ${a.height ?? null}, ${a.duration ?? null}, ${a.license ?? null},
       ${a.author ?? null}, ${a.pageUrl ?? null}, ${a.checksum ?? null}, now())
    on conflict (provider, provider_id, kind) do update set
      local_path = excluded.local_path, bytes = excluded.bytes, width = excluded.width,
      height = excluded.height, duration = excluded.duration, checksum = excluded.checksum,
      last_used_at = now()
    returning *`;
  const row = rows[0];
  if (!row) throw new Error('upsertCachedAsset: no row returned');
  return row;
}

export async function touchCachedAsset(id: string): Promise<void> {
  await sql`update asset_cache set last_used_at = now() where id = ${id}`;
}

// Least-recently-used cached assets first (doc 14 §cache eviction by last_used_at).
export async function assetCacheLRU(
  limit = 200,
): Promise<{ id: string; local_path: string; bytes: number | null }[]> {
  const rows = await sql<{ id: string; local_path: string; bytes: number | null }[]>`
    select id, local_path, bytes from asset_cache order by last_used_at asc nulls first limit ${limit}`;
  return [...rows];
}

export async function deleteAssetCacheByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`delete from asset_cache where id = any(${ids})`;
}

export async function deleteAllAssetCache(): Promise<number> {
  const rows = await sql`delete from asset_cache returning id`;
  return rows.length;
}

export interface ChosenMediaRow {
  beatId: string;
  idx: number;
  text: string;
  narration: unknown;
  shotType: string | null;
  emotion: string | null;
  provider: string;
  providerId: string;
  kind: string;
  remoteUrl: string | null;
  thumbPath: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  author: string | null;
  pageUrl: string | null;
  license: string | null;
}

export type MusicTrackRow = Database['public']['Tables']['music_tracks']['Row'];
export type RenderRow = Database['public']['Tables']['renders']['Row'];

export async function getMusicTracks(): Promise<MusicTrackRow[]> {
  const rows = await sql<MusicTrackRow[]>`select * from music_tracks order by id`;
  return [...rows];
}

export async function getMusicTrackById(id: string): Promise<MusicTrackRow | null> {
  const rows = await sql<MusicTrackRow[]>`select * from music_tracks where id = ${id}`;
  return rows[0] ?? null;
}

export interface RenderInsert {
  projectId: string;
  preset: string;
  aspect: string;
  path: string;
  thumbnailPath?: string;
  duration?: number;
  bytes?: number;
  timeline: JsonValue;
}

export async function insertRender(r: RenderInsert): Promise<RenderRow> {
  const rows = await sql<RenderRow[]>`
    insert into renders (project_id, preset, aspect, path, thumbnail_path, duration, bytes, timeline)
    values (${r.projectId}, ${r.preset}, ${r.aspect}, ${r.path}, ${r.thumbnailPath ?? null},
            ${r.duration ?? null}, ${r.bytes ?? null}, ${sql.json(r.timeline)})
    returning *`;
  const row = rows[0];
  if (!row) throw new Error('insertRender: no row returned');
  return row;
}

// The chosen asset per beat (doc 09 → doc 13), ordered by beat index — the input to
// fetch/normalize. Beats without a chosen candidate are omitted.
export async function getChosenMedia(projectId: string): Promise<ChosenMediaRow[]> {
  const rows = await sql<ChosenMediaRow[]>`
    select b.id as "beatId", b.idx, b.text, b.narration, b.shot_type as "shotType", b.emotion,
      c.provider, c.provider_id as "providerId", c.kind, c.remote_url as "remoteUrl",
      c.thumb_path as "thumbPath", c.width, c.height, c.duration,
      c.author, c.page_url as "pageUrl", c.license
    from beats b join candidates c on c.id = b.chosen_candidate_id
    where b.project_id = ${projectId}
    order by b.idx`;
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
