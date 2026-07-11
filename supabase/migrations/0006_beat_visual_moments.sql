-- Semantic montage moments (doc 23 §7b). When a beat's sentence spans several distinct
-- images, analyze emits an ordered list of filmable sub-phrases; score embeds them and
-- assigns each its best-matching clip. Empty/null ⇒ single image (or the diverse-montage
-- fallback). Nullable + additive — existing rows and the single-image path are unaffected.
alter table beats add column if not exists visual_moments jsonb;
