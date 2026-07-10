-- Phase 0: intentionally empty.
-- The real schema lands in Phase 1 as 0001_init.sql (doc 05), followed by
-- 0002_seed_music.sql. This migration only proves that `supabase db reset`
-- applies migrations cleanly against a fresh local stack.
select 1;
