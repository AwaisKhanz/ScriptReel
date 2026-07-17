-- 0012_enable_rls.sql — close the anon hole on Supabase Cloud.
--
-- 0001's header says "v1 is single-user, local-first: RLS is DISABLED". That was correct when
-- the DB was a localhost Docker Postgres. The 2026-07-10 stack change moved it to Supabase
-- CLOUD (aws-1-ap-south-1.pooler.supabase.com) and the decision was never revisited: the
-- premise that justified it — "local" — stopped being true, so the justification expired but
-- the setting didn't.
--
-- What that means on Cloud, concretely. Supabase's bootstrap runs
--   alter default privileges in schema public grant all on tables to anon, authenticated, ...
-- and `supabase db push` connects as `postgres`, so every table these migrations create grants
-- ALL to `anon`; PostgREST exposes the public schema by default. Anyone holding the anon key
-- and the project ref can therefore
--   GET    /rest/v1/provider_keys?select=*     → every provider key, in PLAINTEXT (0004 stores
--                                                `secret text not null`, unencrypted)
--   DELETE /rest/v1/projects                   → wipe every project
-- and 0001:140 already publishes `projects` + `pipeline_runs` to `supabase_realtime`, so a
-- Realtime subscription would stream every row change to any anon subscriber too.
--
-- The anon key is not a secret by design — it ships under a NEXT_PUBLIC_ name whose whole
-- contract is "safe to inline into a browser bundle", and docs/05 §Realtime still instructs the
-- next implementer to add exactly the client subscription that would publish it. Today nothing
-- does (the UI polls; @supabase/supabase-js is not even a dependency) — but that is an accident
-- of implementation, not a control.
--
-- The fix is free. RLS with NO policies denies everything to `anon`/`authenticated`, while the
-- worker and web both connect via DATABASE_URL as `postgres`, which has BYPASSRLS — so not one
-- query in packages/db changes behaviour. If a browser client is ever added, add policies then;
-- until it is, deny-by-default is the correct posture for an internet-reachable database.
--
-- Verify: select relname, relrowsecurity from pg_class
--         where relnamespace = 'public'::regnamespace and relkind = 'r';

alter table projects        enable row level security;
alter table pipeline_runs   enable row level security;
alter table beats           enable row level security;
alter table candidates      enable row level security;
alter table asset_cache     enable row level security;
alter table renders         enable row level security;
alter table music_tracks    enable row level security;
alter table provider_usage  enable row level security;
alter table provider_keys   enable row level security;
