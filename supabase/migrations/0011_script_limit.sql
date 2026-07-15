-- Raise the projects.script length cap 6,000 → 50,000 to match the app-level limit
-- (apps/web api/projects zod validation + the new-project wizard). Widening only — every
-- existing row already satisfies ≤ 6,000 ≤ 50,000, so this is safe and needs no backfill.
alter table projects drop constraint if exists projects_script_check;
alter table projects
  add constraint projects_script_check check (char_length(script) between 50 and 50000);
