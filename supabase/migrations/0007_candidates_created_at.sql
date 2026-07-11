-- Live pipeline activity (doc 16): the run screen streams the media found so far,
-- newest first. Candidates need an insert timestamp to order that stream; additive +
-- defaulted, so existing rows and inserts are unaffected.
alter table candidates add column if not exists created_at timestamptz not null default now();
create index if not exists candidates_created_at_idx on candidates (created_at desc);
