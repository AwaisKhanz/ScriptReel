-- doc 25 §2 — per-beat era (modern | historical | timeless). Guides which archives a beat
-- is routed to (Phase 2b) and is a hard signal in the verify cascade (Phase 4D). Defaults to
-- 'timeless' so existing rows stay valid.
alter table beats add column if not exists era text not null default 'timeless';
