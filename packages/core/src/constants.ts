import type { PipelineStage } from './jobs';

// Render frame rate is fixed at 30 (doc 02 §3, doc 12).
export const FPS = 30;
export const FRAME_SEC = 1 / FPS;

// Overall progress weighting for the UI (doc 06); weights sum to 100.
export const PROGRESS_WEIGHTS: Readonly<Record<PipelineStage, number>> = {
  analyze: 8,
  search: 14,
  score: 10,
  tts: 14,
  align: 6,
  fetch: 22,
  compose: 26,
};

// Narration pacing — words/sec (chars/sec for CJK). [CALIBRATE] owned by Phase 3
// (doc 10 baseWps); doc 07 uses these for the analyze duration estimate.
export const BASE_WPS: Readonly<Record<string, number>> = {
  'en-US': 2.7,
  'en-GB': 2.7,
  es: 2.9,
  fr: 2.8,
  hi: 2.5,
  it: 2.9,
  'pt-BR': 2.8,
  ja: 5.5,
  zh: 4.5,
};
export const DEFAULT_WPS = 2.7;
export const CJK_LANGUAGES = ['ja', 'zh'] as const;

// Merge/split thresholds for the analyze post-pass (doc 07 §post-pass).
export const MERGE_MIN_SEC = 2.5;
export const SPLIT_MAX_SEC = 12;

// Sanity bounds on the analyzer's plan — NOT a target. The number of shots a beat needs is
// the number of distinct things it puts on screen, which only the analyzer can know: a beat
// naming five foods needs five shots, a beat holding one idea needs one. These exist solely
// so a malformed response can't produce a beat with 200 shots; the prompt sets no count and
// the post-pass never truncates to a "nice" number. Screen time is what actually limits a
// montage (MONTAGE_HARD_MIN_SEG_SEC below), and that bound is applied where the duration is
// known — at plan time, not here.
export const MAX_SHOTS_PER_BEAT = 12;
export const MAX_ENTITIES_PER_BEAT = 12;

// Media provider budgets + cache (doc 22 §budgets, doc 08). These are the real
// documented free-tier limits and act only as the pre-test estimate — the per-key
// "Test" action reads each key's TRUE limit live from the provider (x-ratelimit-*
// headers / Openverse rate_limit endpoint), which can be higher (doc 23 §4).
export const PEXELS_HOUR_BUDGET = 200; // Pexels free: 200 req/hour
export const PEXELS_MONTH_BUDGET = 20_000; // Pexels free: 20,000 req/month
export const PIXABAY_MINUTE_BUDGET = 100; // Pixabay free: 100 req / 60 s
export const OPENVERSE_DAY_BUDGET = 10_000; // Openverse registered (OAuth) tier ≈ 10k/day; anon ≈ 100/day
export const NASA_HOUR_BUDGET = 1_000; // NASA images-api has no published cap; self-imposed polite ceiling
export const WIKIMEDIA_HOUR_BUDGET = 1_000; // Commons API has no hard key cap; self-imposed polite ceiling
export const WIKIDATA_HOUR_BUDGET = 1_000; // Wikidata + Commons resolution; keyless, self-imposed polite ceiling
export const MET_HOUR_BUDGET = 1_000; // Met Collection API, keyless, self-imposed polite ceiling
export const INTERNET_ARCHIVE_HOUR_BUDGET = 1_000; // Internet Archive, keyless, self-imposed polite ceiling
export const INATURALIST_HOUR_BUDGET = 1_000; // iNaturalist, keyless, self-imposed polite ceiling
export const USGS_HOUR_BUDGET = 1_000; // USGS ScienceBase, keyless, self-imposed polite ceiling
export const LIBRARY_OF_CONGRESS_HOUR_BUDGET = 1_000; // Library of Congress, keyless, self-imposed polite ceiling
export const FLICKR_HOUR_BUDGET = 1_000; // Flickr, keyed, self-imposed polite ceiling
export const EUROPEANA_HOUR_BUDGET = 1_000; // Europeana, keyed, self-imposed polite ceiling
export const SMITHSONIAN_HOUR_BUDGET = 1_000; // Smithsonian Open Access, keyed, self-imposed polite ceiling
export const WELLCOME_HOUR_BUDGET = 1_000; // Wellcome Collection, keyless, self-imposed polite ceiling
export const RESEARCH_RESERVE = 30; // kept free for storyboard re-search
export const SEARCH_CACHE_TTL_H = 24; // Pixabay requires ≥24 h caching
export const PER_PAGE_VIDEO = 20;
export const PER_PAGE_PHOTO = 15;
export const MAX_CANDIDATES_PER_BEAT = 40;
export const STORYBOARD_CANDIDATES = 5; // swap alternates shown per beat (keep it scannable)
export const THUMB_MAX_SIDE = 384; // SigLIP input efficiency

// Matching / scoring weights (doc 09 §step 2). Fixed formula terms.
export const SCORE_WEIGHTS = {
  sim: 0.62,
  quality: 0.14,
  orient: 0.1,
  video: 0.04, // motion premium, mixed mode only
  illustration: 0.05, // subtracted
} as const;
export const QUALITY_WEIGHTS = { res: 0.5, dur: 0.3, fps: 0.2 } as const;

// Provenance / authority bonus (doc 24 §7). Added to a candidate from a source that is
// authoritative FOR THIS BEAT'S TOPIC (topics.ts routing) or the entity resolver
// (wikidata-commons), so an authentic/authoritative asset outranks a prettier generic-stock
// stand-in of similar similarity. Added un-multiplied in rankBeat — intrinsic to the candidate
// (like the gate penalties), NOT part of baseScore, which is pure media features. Sized a few ×
// the τ_hi/τ_lo gap so it breaks near-ties without lifting an off-topic or low-sim asset over a
// clearly-better match (sim still dominates at 0.62, and the verify gates still veto misfits).
// [CALIBRATE Phase 8] — re-run `pnpm eval:matching` after tuning.
export const AUTHORITY_BONUS = 0.05;

// Sequential selection penalties (doc 09 §step 2). Applied during greedy selection.
export const REUSE_PENALTY = 0.15; // same asset already chosen this project
export const DUP_PENALTY = 0.1; // near-duplicate of the adjacent beat
export const MONOTONY_PENALTY = 0.04; // same author as the previous chosen beat
export const DUP_COSINE = 0.92; // thumb cosine above this = visual near-duplicate

// Montage planning (doc 23 §7). A beat long enough to hold several visuals is split
// into a mini-sequence of diverse clips instead of one static hold — the anti-boring
// lever. [CALIBRATE 23e]
//
// TWO CADENCES, deliberately different, because they answer different questions.
// When the analyzer PLANNED the shots, its count IS the intent — "apple, then mango, then
// yogurt" is three cuts, and pacing them at a 2.5 s documentary hold would drop two of the
// three foods. So a planned montage is bounded only by MONTAGE_HARD_MIN_SEG_SEC: fit as many
// of the planned shots as the beat has screen time for. The target/max/min below govern the
// BLIND fill instead — planMontage padding a beat with diverse alternates when there is no
// plan to honour — where nothing is being expressed and a calm cadence is the safer default.
export const MONTAGE_TARGET_SEG_SEC = 2.5; // blind fill: ~2.5 s per shot — documentary cadence
export const MONTAGE_MAX_SEGMENTS = 4; // blind fill: no plan to honour, so don't over-cut
export const MONTAGE_MIN_SEG_SEC = 1.8; // blind fill: shorter than this feels like a flash
// Absolute floor for a PLANNED segment. A list sentence — "the apple, mango and yogurt are
// powerful for old people for their liver", ~4.8 s at normal pacing — is five cuts at ~1 s
// each. That is the style, not a defect, and the 1.8 s blind-fill floor would silently show
// two of the five. Below ~0.8 s a shot stops reading as an image and becomes a flicker.
// [CALIBRATE]
export const MONTAGE_HARD_MIN_SEG_SEC = 0.8;
export const MONTAGE_DIVERSITY_COSINE = 0.85; // segments must differ (thumb cosine ≤ this)
// Kind mixing (photo ⇄ video) inside a montage: when every segment so far is one kind,
// prefer the best other-kind candidate if it ranks within this window for the slot —
// rank-based (no absolute sim threshold), so it needs no re-calibration. [CALIBRATE 23e]
export const MONTAGE_MIX_RANK = 5;
// Montage guarantee ladder (doc 23 §7b): when the strict diversity pass finds only
// near-duplicates, retry relaxed before falling back to multi-window same-source cuts —
// two slightly-similar shots still beat one long static hold. [CALIBRATE 23e]
export const MONTAGE_DIVERSITY_RELAXED = 0.95;
// Same-source montage needs spare footage for distinct windows: source must be at
// least this × the beat duration. Lowered so most stock videos (10–20 s) self-cut into
// a montage instead of holding one static shot — the main "why is this beat single" lever.
// [CALIBRATE 23e / doc 24]
export const MONTAGE_SAME_SOURCE_FACTOR = 1.25;

// Greedy selection thresholds in base-score space. SigLIP cosine ranges are
// model-specific — these were CALIBRATED in Phase 6 from 30 labeled pairs (G1–G3)
// with siglip2-base-patch16-224: τ_hi = 90%-precision point, τ_lo = 70%-precision
// point (`pnpm eval:matching`, precision@1 = 100%). Re-run and re-fit on any model
// or formula change (doc 09 §step 3, doc 21). Scores compress near ~0.30 because the
// non-sim quality/orient terms are ~constant for HD stock video.
// [CALIBRATE] Re-fitted 2026-07-16 on 222 pairs / 30 beats (was 0.322, fitted to just 30 pairs
// from G1–G3 — and that 30-pair subset still reproduces 0.322 exactly, which is what overfitting
// looks like). At 0.322 the real precision is 78.8% on stock-servable beats and 63.7% across the
// whole set — not the 90% the tier claims. The honest @90% point on the servable subset is 0.360.
// Model-specific (siglip2-base-patch16-224, base-score space); re-run `pnpm eval:matching` after
// any model or formula change.
// CAVEAT: 192/222 of those labels are AI-judged (see labels.jsonl `labeledBy`) and the beat mix is
// hand-picked, so treat 0.360 as a better estimate than 0.322 — not as ground truth.
// τ_lo deliberately NOT lowered to its measured @70% (0.300): that would ACCEPT more marginal
// candidates, which is not the defect we demonstrated. Raising τ_hi only tightens, and still
// widens the band from 0.008 → 0.046.
export const TAU_HI = 0.36; // [CALIBRATE Phase 6] choose outright (@90% precision, servable subset)
export const TAU_LO = 0.314; // [CALIBRATE Phase 6] choose but flag 'weak'
export const TAU_MOOD = 0.28; // [CALIBRATE Phase 7] mood-tier accept < τ_lo

// OCR gate (doc 25 §5, cascade A). Tesseract reads each beat's SigLIP top-K shortlist;
// a watermark / heavy text overlay lowers the score (penalty), and an egregious full
// overlay or era-contradicting burned-in date drops the candidate (veto). All numbers
// [CALIBRATE] doc 25 §5 (owned by Step 5) — tune once OCR runs on real footage.
export const OCR_TOP_K = 5; // [CALIBRATE] doc 25 §5 (owned by Step 5) — shortlist size the gate OCRs
export const OCR_MIN_CONF = 45; // [CALIBRATE] doc 25 §5 (owned by Step 5) — tesseract per-word conf floor (mirrored sidecar-side in ocr.py)
export const OCR_COVERAGE_FLOOR = 0.03; // [CALIBRATE] doc 25 §5 (owned by Step 5) — below this, text is incidental → no coverage penalty
export const OCR_COVERAGE_CEIL = 0.22; // [CALIBRATE] doc 25 §5 (owned by Step 5) — at/above this, coverage penalty is full
export const OCR_COVERAGE_VETO = 0.35; // [CALIBRATE] doc 25 §5 (owned by Step 5) — mostly-text image → veto (drop)
export const OCR_WATERMARK_PENALTY = 0.12; // [CALIBRATE] doc 25 §5 (owned by Step 5) — a stock-site/copyright token is present
export const OCR_COVERAGE_PENALTY = 0.15; // [CALIBRATE] doc 25 §5 (owned by Step 5) — max coverage-driven penalty (scaled floor→ceil)
export const OCR_MAX_PENALTY = 0.25; // [CALIBRATE] doc 25 §5 (owned by Step 5) — cap on the combined OCR penalty
export const OCR_ERA_MODERN_YEAR = 1975; // [CALIBRATE] doc 25 §5 (owned by Step 5) — a burned-in year ≥ this contradicts a historical beat

// Reference-identity gate (doc 25 §5-C, cascade C). For a beat naming a specific
// person / landmark / artwork, the score stage compares each SigLIP top-5 candidate to
// the entity's Wikidata reference image with a local model: InsightFace face cosine
// (person → veto a clear mismatch) or DINOv2 image cosine (landmark/building/artwork →
// penalize a mismatch). Cosine ranges are model-specific — recalibrate on any model
// swap (never copy τ across models). All numbers [CALIBRATE] doc 25 §6 (owned by Step 6).
export const IDENTITY_FACE_TAU = 0.32; // [CALIBRATE] doc 25 §6 (owned by Step 6) — InsightFace cosine below which the face is a different person
export const IDENTITY_DINO_TAU = 0.55; // [CALIBRATE] doc 25 §6 (owned by Step 6) — DINOv2 cosine below which it's a different landmark/artwork
export const IDENTITY_MISMATCH_PENALTY = 0.15; // [CALIBRATE] doc 25 §6 (owned by Step 6) — score docked for a landmark/artwork identity mismatch (subtracted un-multiplied)
export const IDENTITY_FACE_CATEGORIES: readonly string[] = ['person']; // [CALIBRATE] doc 25 §6 (owned by Step 6) — categories routed to InsightFace
export const IDENTITY_DINO_CATEGORIES: readonly string[] = ['landmark', 'building', 'artwork']; // [CALIBRATE] doc 25 §6 (owned by Step 6) — categories routed to DINOv2

// VLM checklist gate (doc 25 §5-D, cascade D). After OCR + identity, Qwen2.5-VL judges
// each beat's SigLIP top-K on a strict-JSON checklist (subject present? shot framing?
// era? contradicting text?): a missing subject or contradicting text VETOES; an era or
// shot-framing miss PENALIZES. The VLM is skipped entirely for a beat with NO named
// entity AND a strong SigLIP margin (a clear generic win needs no VLM call). All numbers
// [CALIBRATE] doc 25 §5-D (owned by Step 7) — tune once the VLM runs on real footage.
export const VLM_TOP_K = 3; // [CALIBRATE] doc 25 §5-D (owned by Step 7) — candidates per beat sent to the VLM
export const VLM_SKIP_MARGIN = 0.05; // [CALIBRATE] doc 25 §5-D (owned by Step 7) — a no-entity beat with top1−top2 sim ≥ this skips the VLM
export const VLM_ERA_PENALTY = 0.12; // [CALIBRATE] doc 25 §5-D (owned by Step 7) — score docked when the era doesn't match (subtracted un-multiplied)
export const VLM_SHOT_PENALTY = 0.06; // [CALIBRATE] doc 25 §5-D (owned by Step 7) — score docked for poor shot framing (subtracted un-multiplied)
export const VLM_MAX_PENALTY = 0.2; // [CALIBRATE] doc 25 §5-D (owned by Step 7) — cap on the combined VLM penalty

// Contrastive-normalisation distractor bank (retrieval redesign §1.1).
//
// SigLIP is trained with a SIGMOID loss, so its pair scores are absolute and uncalibrated rather
// than a distribution over candidates: a photogenic image scores respectably against ANY prompt.
// That is measurably the core scoring bug here — `pnpm eval:matching` puts good vs bad only ~0.03
// apart with a rank-1 margin of ~0.011, while the selector applies penalties of 0.05–0.25 (5–20x
// the margin), so a single lever outvotes the semantic signal.
//
// spec(I,T) = cos(I,T) − mean_j cos(I,D_j) subtracts an image's mean similarity to these generic
// prompts, measuring how SPECIFICALLY it matches this beat instead of how embeddable it is in
// general. Deliberately broad and mutually spread so no single entry aligns with a real beat's
// subject; embedded once and reused (they never change).
export const SPEC_DISTRACTORS: readonly string[] = [
  'a photograph',
  'a video frame',
  'a landscape',
  'a person',
  'a person indoors',
  'a close-up of an object',
  'an aerial view',
  'a city street',
  'nature',
  'an abstract pattern',
  'a texture',
  'a building',
  'an animal',
  'food on a plate',
  'a machine',
  'a document',
  'a crowd of people',
  'the sky',
  'water',
  'a plant',
  'an empty interior room',
  'a vehicle',
  'a hand',
  'a screen or display',
];

// Snapshot of every calibration constant that changes score-stage OUTPUT. The score stage folds
// this into its inputsHash so re-tuning any value here automatically invalidates the cached
// selection — without it a τ change silently does nothing on an already-scored project (you'd have
// to remember to bump the stage's `logic` string). Keep new score/gate/montage constants in sync
// here; it only affects cache keying, never the scoring math.
export const SCORE_CALIBRATION = {
  SCORE_WEIGHTS,
  QUALITY_WEIGHTS,
  AUTHORITY_BONUS,
  REUSE_PENALTY,
  DUP_PENALTY,
  MONOTONY_PENALTY,
  DUP_COSINE,
  TAU_HI,
  TAU_LO,
  TAU_MOOD,
  MONTAGE_TARGET_SEG_SEC,
  MONTAGE_MAX_SEGMENTS,
  MONTAGE_MIN_SEG_SEC,
  MONTAGE_HARD_MIN_SEG_SEC,
  MONTAGE_DIVERSITY_COSINE,
  MONTAGE_DIVERSITY_RELAXED,
  MONTAGE_MIX_RANK,
  MONTAGE_SAME_SOURCE_FACTOR,
  OCR_TOP_K,
  OCR_MIN_CONF,
  OCR_COVERAGE_FLOOR,
  OCR_COVERAGE_CEIL,
  OCR_COVERAGE_VETO,
  OCR_WATERMARK_PENALTY,
  OCR_COVERAGE_PENALTY,
  OCR_MAX_PENALTY,
  OCR_ERA_MODERN_YEAR,
  IDENTITY_FACE_TAU,
  IDENTITY_DINO_TAU,
  IDENTITY_MISMATCH_PENALTY,
  IDENTITY_FACE_CATEGORIES,
  IDENTITY_DINO_CATEGORIES,
  VLM_TOP_K,
  VLM_SKIP_MARGIN,
  VLM_ERA_PENALTY,
  VLM_SHOT_PENALTY,
  VLM_MAX_PENALTY,
} as const;
