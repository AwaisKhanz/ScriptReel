# 05 — Data Model (Supabase local / Postgres 15)

Migrations live in `supabase/migrations/`, written by hand (no ORM migrations). Access from Node via `postgres.js` in `packages/db` with generated types (`supabase gen types typescript`). pg-boss owns its own `pgboss` schema — never touch it directly.

v1 is single-user local: **RLS disabled**, `user_id uuid null` columns exist on `projects` for forward-compatibility but are unused. Document this in the migration header.

## Enums

```sql
create type project_status  as enum ('draft','queued','running','awaiting_review','failed','done');
create type run_status      as enum ('pending','running','done','failed','skipped');
create type pipeline_stage  as enum ('analyze','search','score','tts','align','fetch','compose');
create type media_kind      as enum ('video','image','generated','textcard');
```

## Tables

```sql
create table projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  title        text not null,
  script       text not null check (char_length(script) between 50 and 6000),
  language     text,                          -- BCP-ish code, set by analyze
  settings     jsonb not null default '{}',   -- zod-validated ProjectSettings (doc 02)
  settings_hash text,                         -- sha1 of normalized settings, for invalidation
  status       project_status not null default 'draft',
  error        jsonb,                         -- {stage, code, message} on failure
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table pipeline_runs (                  -- one row per stage per project (upserted per attempt)
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  stage       pipeline_stage not null,
  status      run_status not null default 'pending',
  progress    int not null default 0 check (progress between 0 and 100),
  attempt     int not null default 0,
  detail      text,                           -- human line: "beat 12/44: scoring"
  error       jsonb,
  started_at  timestamptz, finished_at timestamptz,
  unique (project_id, stage)
);

create table beats (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects(id) on delete cascade,
  idx                int not null,
  text               text not null,           -- verbatim script slice
  visual_description text,                    -- English, filmable (doc 07)
  key_phrase         text,
  emotion            text,                    -- enum-in-code (doc 07)
  shot_type          text,
  entities           jsonb,                   -- {people[],places[],objects[]}
  queries            jsonb,                   -- {literal[2], conceptual, mood}
  est_seconds        numeric,
  narration          jsonb,                   -- {audioPath, durationSec, startSec} set by tts
  chosen_candidate_id uuid,                   -- fk added after candidates
  forced_textcard    boolean not null default false,
  unique (project_id, idx)
);

create table candidates (
  id          uuid primary key default gen_random_uuid(),
  beat_id     uuid not null references beats(id) on delete cascade,
  provider    text not null,                  -- 'pexels'|'pixabay'|'generated'|'textcard'
  provider_id text not null,
  kind        media_kind not null,
  width int, height int, duration numeric,    -- duration null for images
  thumb_path  text,                           -- local cached thumb (input to embedder)
  remote_url  text,                           -- best-fit download URL
  page_url    text, author text, license text,
  score numeric, rank int,
  meta jsonb,
  unique (beat_id, provider, provider_id)
);
alter table beats add constraint beats_chosen_fk
  foreign key (chosen_candidate_id) references candidates(id) on delete set null;

create table asset_cache (                    -- downloaded originals, shared across projects
  id uuid primary key default gen_random_uuid(),
  provider text not null, provider_id text not null, kind media_kind not null,
  local_path text not null, bytes bigint, width int, height int, duration numeric,
  license text, author text, page_url text,
  checksum text, last_used_at timestamptz not null default now(),
  unique (provider, provider_id, kind)
);

create table renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  preset text not null,                       -- 'draft'|'final'
  aspect text not null,                       -- '16:9'|'9:16'|'1:1'
  path text not null, thumbnail_path text,
  duration numeric, bytes bigint,
  timeline jsonb not null,                    -- frozen copy of timeline.json used
  created_at timestamptz not null default now()
);

create table music_tracks (                   -- seeded from assets/music/manifest.json
  id text primary key, title text not null, moods text[] not null,
  bpm int, duration numeric, path text not null,
  license text not null default 'CC0', credit text
);

create table provider_usage (                 -- durable rate-limit accounting (doc 08)
  provider text not null, window_start timestamptz not null, requests int not null default 0,
  primary key (provider, window_start)
);
```

Indexes: `beats(project_id, idx)`, `candidates(beat_id, rank)`, `pipeline_runs(project_id)`, `asset_cache(last_used_at)` for eviction.

## Realtime

Enable Supabase Realtime on `pipeline_runs` and `projects` (publication `supabase_realtime`). The UI subscribes filtered by `project_id`. All progress UX is row-driven — no websocket layer of our own.

## Invalidation keys

`projects.settings_hash` plus per-stage input hashes stored inside each stage manifest on disk (doc 06). DB is the source of truth for *state*; disk manifests are the source of truth for *artifacts*.

## Seed

Migration `0002_seed_music.sql` inserts `music_tracks` from the committed manifest. Voices are a code constant (`packages/core/src/voices.ts`), not a table.
