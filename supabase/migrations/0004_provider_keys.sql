-- Provider key pool (doc 23): multiple API keys/tokens per provider so combined
-- free-tier quota scales and the pipeline keeps running past a single account's cap.
-- Per-key usage is accounted in provider_usage under keys like 'pexels:hour#<id>'.
create table if not exists provider_keys (
  id         uuid primary key default gen_random_uuid(),
  provider   text not null,                 -- 'pexels' | 'pixabay' | 'openverse'
  label      text,                          -- user note, e.g. "account 1"
  secret     text not null,                 -- the API key / token
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists provider_keys_provider_idx on provider_keys (provider, active);
