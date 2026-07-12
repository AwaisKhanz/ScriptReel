-- Per-asset motion analysis cache (doc 23 §8). The fetch stage samples per-frame
-- motion (ffmpeg scdet) to pick clip windows; that analysis is a pure function of the
-- downloaded file, so cache it on the shared asset row — re-renders, swaps, and other
-- projects reusing the asset skip the ffmpeg pass entirely. Nullable + additive.
alter table asset_cache add column if not exists motion jsonb;
