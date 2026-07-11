-- Montage segments (doc 23 §7). A beat's visual can be an ordered sequence of clips
-- (morning → subway → platform …) instead of one static hold. The plan is the ordered
-- list of chosen candidate ids + weights; null ⇒ single visual (chosen_candidate_id).
-- Nullable + additive, so existing rows and the single-visual path are unaffected.
alter table beats add column if not exists segments jsonb;
