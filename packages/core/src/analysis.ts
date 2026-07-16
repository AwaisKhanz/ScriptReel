import { z } from 'zod';
import { BASE_WPS, CJK_LANGUAGES, DEFAULT_WPS, MERGE_MIN_SEC, SPLIT_MAX_SEC } from './constants';
import { PipelineError } from './errors';
import type { PACINGS } from './settings';

// ── Schemas (single source of truth, doc 07) ──────────────────────────────
export const EmotionSchema = z.enum([
  'neutral',
  'uplifting',
  'serious',
  'tense',
  'sad',
  'exciting',
  'calm',
  'inspiring',
]);
export type Emotion = z.infer<typeof EmotionSchema>;

export const ShotTypeSchema = z.enum(['wide', 'medium', 'close', 'detail', 'aerial', 'abstract']);
export type ShotType = z.infer<typeof ShotTypeSchema>;

// The time period a beat's visuals should evoke (doc 25 §2) — guides retrieval + verification.
export const EraSchema = z.enum(['modern', 'historical', 'timeless']);
export type Era = z.infer<typeof EraSchema>;

export const MusicMoodSchema = z.enum([
  'uplifting',
  'calm',
  'corporate',
  'emotional',
  'energetic',
  'tense',
  'none',
]);

// Entity categories (doc 24 §2) — guide authoritative-source routing. Broad + lowercase;
// unknown categories simply fall back to generic sourcing, so the list can grow freely.
export const EntityCategorySchema = z.enum([
  'person',
  'country',
  'region',
  'city',
  'landmark',
  'lake',
  'ocean',
  'mountain',
  'river',
  'nature',
  'animal',
  'planet',
  'astro',
  'building',
  'vehicle',
  'company',
  'brand',
  'product',
  'software',
  'artwork',
  'book',
  'film',
  'event',
  'concept',
  'object',
  'symbol',
  'flag',
]);
export type EntityCategory = z.infer<typeof EntityCategorySchema>;

// A concrete, on-screen thing named in a beat (doc 24 §2). The LLM supplies the name +
// category + expected class; the worker resolves it to an authoritative asset (Wikidata →
// Commons / NASA) and VERIFIES the sense via `instanceOf`. The LLM never emits Q-ids.
export const EntitySchema = z.object({
  surface: z.string().min(1), // as written in the narration ("the Dead Sea")
  canonical: z.string().min(1), // disambiguated English name ("Dead Sea")
  category: EntityCategorySchema,
  instanceOf: z.string().default(''), // expected class, lowercase ("lake") — verifies the hit
  disambiguation: z.string().default(''), // one clause fixing the sense
  searchTerms: z.string().array().max(4).default([]), // English fallback queries
  visualizable: z.boolean(), // false ⇒ abstract ⇒ generic b-roll / text card
});
export type Entity = z.infer<typeof EntitySchema>;

// What KIND of asset a shot needs — turns a category into the right Commons property
// (doc 24 §4). `generic` = a mood/action shot with no named subject.
export const ShotWantSchema = z.enum([
  'portrait',
  'flag',
  'map',
  'aerial',
  'logo',
  'footage',
  'scene',
  'generic',
]);
export type ShotWant = z.infer<typeof ShotWantSchema>;

// One ordered shot in a beat's visual plan (doc 24 §3). `entity` is the canonical name of
// the beat entity it depicts (a stable key that survives merge/dedupe), '' for a generic shot.
export const ShotSchema = z.object({
  phrase: z.string().min(1), // concrete searchable English phrase ("dead sea aerial view")
  entity: z.string().default(''), // canonical of the depicted entity, '' = generic
  want: ShotWantSchema.default('generic'),
  weight: z.number().positive().default(1), // relative on-screen time
});
export type Shot = z.infer<typeof ShotSchema>;

export const BeatSchema = z.object({
  text: z.string().min(1), // VERBATIM slice of the script
  visualDescription: z.string().max(160), // English, filmable
  keyPhrase: z.string().max(48), // ≤6 words, script language
  emotion: EmotionSchema,
  shotType: ShotTypeSchema,
  era: EraSchema.default('timeless'), // modern | historical | timeless (doc 25 §2, rule 12)
  // Typed entities (doc 24 §2) — drive authoritative sourcing; REAL names belong here.
  entities: EntitySchema.array().max(8).default([]),
  queries: z.object({
    literal: z.string().array().length(2), // tier 1 — concrete (GENERIC stock, no real names)
    conceptual: z.string(), // tier 2 — the idea
    mood: z.string(), // tier 3 — atmosphere
  }),
  // Ordered visual plan (doc 24 §3): the 2–4 shots that tell the beat's story (one shot
  // for a truly single-image beat). Real names allowed — these drive archives.
  shots: ShotSchema.array().max(6).default([]),
});
export type Beat = z.infer<typeof BeatSchema>;

export const AnalysisResultSchema = z.object({
  language: z.string(),
  musicMood: MusicMoodSchema,
  beats: BeatSchema.array().min(1),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export type Pacing = (typeof PACINGS)[number];

export interface AnalyzeInput {
  script: string;
  languageHint?: string;
  pacing: Pacing;
}

export interface AnalyzeOptions {
  retryHint?: string; // appended to the prompt on a single reprompt
}

export interface ScriptAnalyzer {
  analyze(input: AnalyzeInput, opts?: AnalyzeOptions): Promise<AnalysisResult>;
}

// ── System prompt (doc 07, verbatim; {PACING_RULE} substituted) ────────────
const PACING_RULES: Readonly<Record<Pacing, string>> = {
  fast: 'Target 8–13 spoken words per beat.',
  normal: 'Target 12–20 spoken words per beat.',
  slow: 'Target 18–28 spoken words per beat.',
};

const SYSTEM_PROMPT = `You segment scripts into VISUAL BEATS for an automated video editor, and you design
what the viewer should SEE during each beat.

RULES — SEGMENTATION
1. Beats must reproduce the input script EXACTLY when their \`text\` fields are
   concatenated in order. Never rewrite, translate, drop, or add words. Preserve
   punctuation. Only leading/trailing whitespace between beats may be normalized.
2. {PACING_RULE}
3. A beat is ONE visual idea. Merge short sentences that share an image. Split long
   sentences at natural clause boundaries when the imagery changes.

RULES — VISUAL DESIGN
4. \`visualDescription\` is ALWAYS ENGLISH, ≤ 20 words, and FILMABLE: describe a shot a
   stock-video camera could capture — subjects, setting, action, lighting. Never
   abstract claims ("revenue grew"), never on-screen text, charts with specific
   numbers, or captions. Translate ideas into imagery: "revenue grew 40%" →
   "upward trending line graph on laptop screen, modern office, confident team".
5. In \`visualDescription\` and \`queries\` (these search GENERIC stock sites), never use
   real people's names, brand names, or logos — replace with generic roles: "Elon
   Musk" → "tech CEO speaking on stage". \`entities\` and \`shots\` are the OPPOSITE
   (rules 10–11): they drive authoritative archives, so REAL names belong there.
6. \`queries\`: ALWAYS ENGLISH, lowercase, 1–4 words, no punctuation.
   - literal[0]: the most concrete subject+context ("rusty farm gate dusk")
   - literal[1]: a different concrete angle of the same idea
   - conceptual: the underlying concept ("hesitation choice")→ as searchable nouns
     ("person standing crossroads")
   - mood: pure atmosphere matching the emotion ("moody countryside sunset")
7. Vary \`shotType\` across consecutive beats when plausible; avoid three identical in a row.
8. \`keyPhrase\`: the beat's essence in ≤ 6 words, in the SCRIPT'S language, suitable
   for a bold on-screen card.
9. Detect \`language\` of the script (en-US, en-GB, es, fr, hi, it, pt-BR, ja, zh) and
   an overall \`musicMood\`.
10. \`entities\` — read the WHOLE script, then for each beat list the concrete, on-screen
   things it names (skip pronouns, connectives, and pure abstractions). For each:
   - \`surface\`: as written in the narration ("the Dead Sea").
   - \`canonical\`: the real, disambiguated English name ("Dead Sea", "Jordan", "Elon
     Musk", "React") — this is what we look up in Wikidata, so get it exactly right.
   - \`category\`: one of person, country, region, city, landmark, lake, ocean, mountain,
     river, nature, animal, planet, astro, building, vehicle, company, brand, product,
     software, artwork, book, film, event, concept, object, symbol, flag.
   - \`instanceOf\`: the general CLASS, lowercase ("lake", "country", "human", "planet",
     "business", "software") — we use it to CONFIRM the right thing was linked.
   - \`disambiguation\`: one short clause fixing the sense ("the salt lake in the Middle
     East, not the given name") — essential for ambiguous names (Jordan, Mercury, Amazon).
   - \`searchTerms\`: up to 3 English phrases to find it ("dead sea aerial", "petra jordan").
   - \`visualizable\`: true when there is a real thing to show; false for pure abstractions
     (freedom, inflation, happiness) — those fall back to generic mood b-roll.
11. \`shots\` — you are the VISUAL DIRECTOR of a premium documentary (the b-roll discipline
   of top explainer channels). For each beat design the 2–4 ordered shots that best TELL
   its story (a truly single-image beat may have just one). For each shot:
   - \`phrase\`: a concrete, searchable 3–6 word English phrase ("dead sea aerial view",
     "jordan locator map", "apollo 11 moon landing").
   - \`entity\`: the \`canonical\` of the beat entity this shot depicts, or "" for a generic
     mood/action shot with no named subject.
   - \`want\`: the KIND of image needed — portrait (a person), flag (a country's flag), map
     (a locator/where-is-it map), aerial (top-down or wide land), logo (a company/brand/
     software mark), footage (archival or action video of the subject), scene (a normal
     photo of the subject), or generic (no named subject).
   - \`weight\`: relative on-screen time, 1–3 (a hero shot gets more).
   Compose the story: a fact with a place AND a subject usually needs 2–4 shots. Countries
   and regions → a flag and/or a map plus a scene; people → a portrait plus footage;
   planets/space → scene or footage. Prefer a sequence of precise STILLS (slow zoom) over
   one generic video.
   Example — "The Dead Sea, between Jordan and Israel, is Earth's saltiest lake" → shots:
   [{phrase:"dead sea aerial view",entity:"Dead Sea",want:"aerial",weight:2},
    {phrase:"jordan locator map",entity:"Jordan",want:"map",weight:1},
    {phrase:"israel locator map",entity:"Israel",want:"map",weight:1},
    {phrase:"dead sea salt formations",entity:"Dead Sea",want:"scene",weight:1}]
12. \`era\` — the time period the beat's VISUALS should evoke: "modern" (contemporary / present-day
   subjects), "historical" (a specific past period or event, pre-modern), or "timeless" (nature,
   space, abstract, or era-agnostic). Infer it from the subject and any dates. It guides which
   archives are searched and is checked during verification; default to "timeless" when unsure.

For Japanese/Chinese target 18–30 characters (fast), 25–45 (normal), 40–65 (slow) per beat.

Return ONLY JSON matching the provided schema.`;

export function buildSystemPrompt(pacing: Pacing): string {
  return SYSTEM_PROMPT.replace('{PACING_RULE}', PACING_RULES[pacing]);
}

// ── Pure post-pass (doc 07 §deterministic post-pass) ──────────────────────
export interface ProcessedBeat {
  idx: number;
  text: string;
  visualDescription: string;
  keyPhrase: string;
  emotion: Emotion;
  shotType: ShotType;
  era: Era; // modern | historical | timeless (doc 25 §2)
  entities: Entity[]; // typed entities (doc 24 §2)
  queries: { literal: string[]; conceptual: string; mood: string };
  shots: Shot[]; // ordered visual plan (doc 24 §3)
  visualMoments: string[]; // derived from shots for back-compat (doc 23 §7b); [] = single
  estSeconds: number;
}

export interface PostProcessInput {
  script: string;
  result: AnalysisResult;
  language: string;
  speed: number;
  // Accept a proportional re-slice, whose boundaries are word-count arithmetic rather than
  // semantic — every beat then carries visuals designed for a different span of the script.
  // Only the final degrade path, after the reprompt has failed, sets this (doc 07).
  allowProportional?: boolean;
}

export interface PostProcessOutput {
  beats: ProcessedBeat[];
  language: string;
  musicMood: AnalysisResult['musicMood'];
  // 'anchored' and 'proportional' were both 'repaired' — one has exact boundaries, the other
  // arithmetic ones, and collapsing them is what let misaligned visuals ship unnoticed.
  reconstruction: 'exact' | RepairMethod;
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function reconstructionMatches(script: string, beats: { text: string }[]): boolean {
  return normalizeWhitespace(beats.map((b) => b.text).join(' ')) === normalizeWhitespace(script);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstWords(text: string, count: number): string[] {
  return normalizeWhitespace(text).split(' ').slice(0, count);
}

// Whitespace-tolerant search for a word sequence; returns [start, end] or null.
function findWordSpan(haystack: string, words: string[], from: number): [number, number] | null {
  if (words.length === 0) return null;
  const pattern = words.map(escapeRegExp).join('\\s+');
  const re = new RegExp(pattern, 'u');
  const match = re.exec(haystack.slice(from));
  if (!match) return null;
  return [from + match.index, from + match.index + match[0].length];
}

// Re-slice the ORIGINAL script at each beat boundary using each beat's first 4 words
// as anchors (doc 07 §post-pass 1). Best boundaries, but fails if the model altered a
// beat's leading words.
function repairByAnchors(script: string, beats: Beat[]): Beat[] | null {
  const repaired: Beat[] = [];
  let cursor = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (!beat) return null;
    const startSpan = findWordSpan(script, firstWords(beat.text, 4), cursor);
    if (!startSpan) return null;
    const start = startSpan[0];

    let end: number;
    const next = beats[i + 1];
    if (next) {
      const nextSpan = findWordSpan(script, firstWords(next.text, 4), start + 1);
      if (!nextSpan) return null;
      end = nextSpan[0];
    } else {
      end = script.length;
    }
    repaired.push({ ...beat, text: script.slice(start, end).trim() });
    cursor = end;
  }
  return reconstructionMatches(script, repaired) ? repaired : null;
}

interface WordSpan {
  start: number;
  end: number;
}

function tokenizeWithSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/gu;
  let match = re.exec(text);
  while (match) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = re.exec(text);
  }
  return spans;
}

// Always-succeeds fallback: split the ORIGINAL script at word boundaries using the
// model's per-beat word-count proportions. Concatenation equals the script, so
// verbatim reconstruction is guaranteed (boundaries may be approximate).
function repairProportional(script: string, beats: Beat[]): Beat[] {
  const spans = tokenizeWithSpans(script);
  const total = spans.length;
  if (total === 0 || beats.length === 0) {
    return beats.map((beat) => ({ ...beat, text: script.trim() }));
  }
  const counts = beats.map((beat) =>
    Math.max(1, normalizeWhitespace(beat.text).split(' ').filter(Boolean).length),
  );
  const sum = counts.reduce((acc, c) => acc + c, 0);
  const repaired: Beat[] = [];
  let cursor = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (!beat) continue;
    const isLast = i === beats.length - 1;
    let take: number;
    if (isLast) {
      take = total - cursor;
    } else {
      const remaining = beats.length - 1 - i;
      const share = Math.round(((counts[i] ?? 1) / sum) * total);
      take = Math.max(1, Math.min(share, Math.max(1, total - cursor - remaining)));
    }
    const endWord = cursor + take;
    const startChar = spans[cursor]?.start ?? 0;
    const endChar =
      isLast || endWord >= total ? script.length : (spans[endWord]?.start ?? script.length);
    repaired.push({ ...beat, text: script.slice(startChar, endChar).trim() });
    cursor = endWord;
  }
  return repaired;
}

// How a beat list was re-sliced back to verbatim. 'anchors' keeps each beat's own words, so
// its visuals still describe its text; 'proportional' does not — the caller must decide.
export type RepairMethod = 'anchors' | 'proportional';

export interface RepairResult {
  beats: Beat[];
  method: RepairMethod;
}

// Anchor-repair first (best boundaries); proportional fallback guarantees verbatim.
export function repairVerbatim(script: string, beats: Beat[]): RepairResult | null {
  const anchored = repairByAnchors(script, beats);
  if (anchored) return { beats: anchored, method: 'anchors' };
  const proportional = repairProportional(script, beats);
  return reconstructionMatches(script, proportional)
    ? { beats: proportional, method: 'proportional' }
    : null;
}

export function estimateSeconds(text: string, language: string, speed = 1): number {
  const wps = (BASE_WPS[language] ?? DEFAULT_WPS) * speed;
  const isCjk = (CJK_LANGUAGES as readonly string[]).includes(language);
  const units = isCjk
    ? [...text.replace(/\s/g, '')].length
    : normalizeWhitespace(text).split(' ').filter(Boolean).length;
  return units / wps;
}

function withEst(beats: ProcessedBeat[], language: string, speed: number): ProcessedBeat[] {
  return beats.map((b) => ({ ...b, estSeconds: estimateSeconds(b.text, language, speed) }));
}

// visualMoments is the back-compat projection of the shot plan (doc 24 §3): the ordered
// shot phrases, capped like the old moments array so search/score stay unchanged.
function deriveMoments(shots: Shot[]): string[] {
  return shots.map((s) => s.phrase).slice(0, 4);
}

// Dedupe entities by canonical name (case-insensitive), preserving first-seen order.
function dedupeEntities(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  const out: Entity[] = [];
  for (const e of entities) {
    const key = e.canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(0, 8);
}

// Merge any beat < MERGE_MIN_SEC into its shorter neighbor, keeping the longer
// beat's visuals (doc 07 §post-pass 3).
export function mergeShortBeats(
  beats: ProcessedBeat[],
  language: string,
  speed: number,
): ProcessedBeat[] {
  const list = withEst(beats, language, speed);
  while (list.length > 1) {
    const idx = list.findIndex((b) => b.estSeconds < MERGE_MIN_SEC);
    if (idx === -1) break;
    const left = idx > 0 ? list[idx - 1] : undefined;
    const right = idx < list.length - 1 ? list[idx + 1] : undefined;
    let targetIdx: number;
    if (left && right) {
      targetIdx = left.estSeconds <= right.estSeconds ? idx - 1 : idx + 1;
    } else if (left) {
      targetIdx = idx - 1;
    } else if (right) {
      targetIdx = idx + 1;
    } else {
      break;
    }
    const a = list[idx];
    const b = list[targetIdx];
    if (!a || !b) break;
    const lo = Math.min(idx, targetIdx);
    const first = idx < targetIdx ? a : b;
    const second = idx < targetIdx ? b : a;
    const longer = a.estSeconds >= b.estSeconds ? a : b;
    const text = normalizeWhitespace(`${first.text} ${second.text}`);
    // Keep the shot plan + entities in text order — merging a short trailing sentence
    // ("His name was Henry.") must not throw away the long beat's visuals (doc 24 §3).
    const mergedShots = [...first.shots, ...second.shots].slice(0, 6);
    const merged: ProcessedBeat = {
      ...longer,
      text,
      entities: dedupeEntities([...first.entities, ...second.entities]),
      shots: mergedShots,
      visualMoments: deriveMoments(mergedShots),
      estSeconds: estimateSeconds(text, language, speed),
    };
    list.splice(lo, 2, merged);
  }
  return list;
}

function boundaryPositions(text: string, punctuation: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (punctuation.includes(text[i] ?? '')) {
      positions.push(i + 1);
    }
  }
  return positions;
}

function splitAtBoundary(text: string): [string, string] | null {
  const mid = text.length / 2;
  let positions = boundaryPositions(text, '.!?。！？');
  if (positions.length === 0) {
    positions = boundaryPositions(text, ',;:，；：');
  }
  positions = positions.filter((p) => p > text.length * 0.15 && p < text.length * 0.85);
  if (positions.length === 0) return null;
  const best = positions.reduce((a, p) => (Math.abs(p - mid) < Math.abs(a - mid) ? p : a));
  const t1 = text.slice(0, best).trim();
  const t2 = text.slice(best).trim();
  return t1 && t2 ? [t1, t2] : null;
}

// Split any beat > SPLIT_MAX_SEC at the boundary nearest its midpoint; the second
// half demotes its literal queries to the conceptual/mood tier (doc 07 §post-pass 4).
export function splitLongBeats(
  beats: ProcessedBeat[],
  language: string,
  speed: number,
): ProcessedBeat[] {
  let list = withEst(beats, language, speed);
  for (let pass = 0; pass < 4; pass += 1) {
    if (!list.some((b) => b.estSeconds > SPLIT_MAX_SEC)) break;
    const next: ProcessedBeat[] = [];
    for (const beat of list) {
      if (beat.estSeconds <= SPLIT_MAX_SEC) {
        next.push(beat);
        continue;
      }
      const split = splitAtBoundary(beat.text);
      if (!split) {
        next.push(beat);
        continue;
      }
      next.push({
        ...beat,
        text: split[0],
        shots: [], // split reshapes the sentence — the shot plan no longer aligns
        visualMoments: [],
        estSeconds: estimateSeconds(split[0], language, speed),
      });
      next.push({
        ...beat,
        text: split[1],
        shots: [],
        visualMoments: [],
        estSeconds: estimateSeconds(split[1], language, speed),
        queries: { ...beat.queries, literal: [beat.queries.conceptual, beat.queries.mood] },
      });
    }
    list = next;
  }
  return list;
}

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lowercase, strip punctuation, and demote a tier-1 query that repeats one from the
// previous beat to the conceptual tier (doc 07 §post-pass 5).
export function queryHygiene(beats: ProcessedBeat[]): ProcessedBeat[] {
  const out: ProcessedBeat[] = [];
  let previous = new Set<string>();
  for (const beat of beats) {
    const conceptual = normalizeQuery(beat.queries.conceptual);
    const mood = normalizeQuery(beat.queries.mood);
    const literal = beat.queries.literal.map((q) => {
      const normalized = normalizeQuery(q);
      return previous.has(normalized) ? conceptual : normalized;
    });
    out.push({ ...beat, queries: { literal, conceptual, mood } });
    previous = new Set([...literal, conceptual, mood]);
  }
  return out;
}

export function postProcessAnalysis(input: PostProcessInput): PostProcessOutput {
  let beats: Beat[] = input.result.beats;
  let reconstruction: PostProcessOutput['reconstruction'] = 'exact';

  if (!reconstructionMatches(input.script, beats)) {
    const repaired = repairVerbatim(input.script, beats);
    if (!repaired) {
      throw new PipelineError(
        'E_LLM_SCHEMA',
        'analyze',
        'verbatim reconstruction failed after repair',
      );
    }
    if (repaired.method === 'proportional' && !input.allowProportional) {
      // A proportional re-slice is contiguous, so its join always equals the script and
      // reconstructionMatches can never catch it. Rejecting it here is the only thing that
      // arms the reprompt — otherwise every beat silently ships another beat's visuals.
      throw new PipelineError(
        'E_LLM_SCHEMA',
        'analyze',
        'anchor repair failed; proportional re-slice would decouple each beat from its own visuals',
      );
    }
    beats = repaired.beats;
    reconstruction = repaired.method;
  }

  const processed: ProcessedBeat[] = beats.map((beat, idx) => ({
    idx,
    text: beat.text,
    visualDescription: beat.visualDescription,
    keyPhrase: beat.keyPhrase,
    emotion: beat.emotion,
    shotType: beat.shotType,
    era: beat.era,
    entities: [...beat.entities],
    queries: {
      literal: [...beat.queries.literal],
      conceptual: beat.queries.conceptual,
      mood: beat.queries.mood,
    },
    shots: [...beat.shots],
    visualMoments: deriveMoments(beat.shots),
    estSeconds: estimateSeconds(beat.text, input.language, input.speed),
  }));

  const merged = mergeShortBeats(processed, input.language, input.speed);
  const split = splitLongBeats(merged, input.language, input.speed);
  const hygiened = queryHygiene(split).map((beat, idx) => ({ ...beat, idx }));

  return {
    beats: hygiened,
    language: input.language,
    musicMood: input.result.musicMood,
    reconstruction,
  };
}
