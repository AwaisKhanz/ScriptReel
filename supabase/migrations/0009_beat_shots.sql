-- doc 24 §10: typed visual plan per beat (ordered shots). The `entities` column is
-- reshaped in place to the typed entity list — it is already jsonb, so no DDL is needed
-- for it; only the new `shots` column is added. Nullable + additive: existing rows and
-- the derived `visual_moments` path keep working.
alter table beats add column if not exists shots jsonb;
