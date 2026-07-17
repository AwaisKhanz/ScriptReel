import { z } from 'zod';
import {
  BASE_WPS,
  CJK_LANGUAGES,
  DEFAULT_WPS,
  MAX_ENTITIES_PER_BEAT,
  MAX_SHOTS_PER_BEAT,
  MERGE_MIN_SEC,
  SPLIT_MAX_SEC,
} from './constants';
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

// Entity categories (doc 24 §2) — guide authoritative-source routing. Broad + lowercase.
//
// This list is a HARD constraint, not a hint: structured outputs constrain the model to these
// values, so a category the taxonomy lacks is not a category the model can approximate — it is
// a thing the model cannot describe. Measured: a beet-juice script returned `entities: []` on
// all nine beats, because "beet juice", "kidneys" and "nitric oxide" had nowhere to land. The
// beat then falls back to generic stock, which is exactly what the entity field exists to avoid.
//
// The everyday categories below (food/plant/anatomy/substance) were the gap. They also close the
// loop with topics.ts, which already had `food` and `medicine` topics — and the authoritative
// sources behind them, Wellcome especially — that NO entity category could route to.
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
  'plant', // a species or crop: "mango tree", "beetroot"
  'food', // anything eaten or drunk: "mango", "yogurt", "beet juice"
  'anatomy', // a body part or system: "the liver", "kidneys", "blood vessels"
  'substance', // a material or compound: "nitric oxide", "oxalates", "granite"
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

// Fallback `want` when a shot is generic but its entity's category has a natural default
// (doc 24 §5): a country → its map, a person → a portrait, etc.
export const CATEGORY_DEFAULT_WANT: Readonly<Record<EntityCategory, ShotWant>> = {
  person: 'portrait',
  country: 'map',
  region: 'map',
  city: 'scene',
  landmark: 'scene',
  lake: 'aerial',
  ocean: 'aerial',
  mountain: 'scene',
  river: 'aerial',
  nature: 'scene',
  animal: 'scene',
  plant: 'scene',
  food: 'scene',
  anatomy: 'scene',
  substance: 'scene',
  planet: 'scene',
  astro: 'scene',
  building: 'scene',
  vehicle: 'scene',
  company: 'logo',
  brand: 'logo',
  product: 'scene',
  software: 'logo',
  artwork: 'scene',
  book: 'scene',
  film: 'scene',
  event: 'footage',
  concept: 'generic',
  object: 'scene',
  symbol: 'scene',
  flag: 'flag',
};

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
  // The bound is a sanity guard, not a target: a beat naming five foods has five entities.
  entities: EntitySchema.array().max(MAX_ENTITIES_PER_BEAT).default([]),
  queries: z.object({
    literal: z.string().array().length(2), // tier 1 — concrete (GENERIC stock, no real names)
    conceptual: z.string(), // tier 2 — the idea
    mood: z.string(), // tier 3 — atmosphere
  }),
  // Ordered visual plan (doc 24 §3): one shot per distinct thing the beat puts on screen —
  // however many that is. Real names allowed — these drive archives.
  shots: ShotSchema.array().max(MAX_SHOTS_PER_BEAT).default([]),
});
export type Beat = z.infer<typeof BeatSchema>;

export const AnalysisResultSchema = z.object({
  language: z.string(),
  musicMood: MusicMoodSchema,
  beats: BeatSchema.array().min(1),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// What the WHOLE script is about, read once before any segmentation (doc 07 §two-pass).
//
// Segmentation is chunked at MAX_CHUNK_WORDS, and a chunk is all the model used to see: chunk 2
// had no idea chunk 1 had introduced Voyager 1, so a later "the spacecraft" resolved to nothing
// and the beat fell to generic stock. `language` and `musicMood` are whole-script properties
// that were being answered from a single chunk — and, since each chunk overwrote the last, the
// final answer came from whichever chunk happened to be last.
export const ScriptBriefSchema = z.object({
  subject: z.string(), // what the script is about, one clause
  topic: z.string(), // the dominant domain, lowercase ("space", "medicine", "food")
  era: EraSchema, // the era the script's visuals should evoke overall
  cast: z.string().array().max(12).default([]), // recurring entities, canonical English names
  language: z.string(), // detected over the whole script
  musicMood: MusicMoodSchema, // chosen for the whole script
});
export type ScriptBrief = z.infer<typeof ScriptBriefSchema>;

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
2. {PACING_RULE} This is a HARD budget, not a suggestion. A beat that runs past it will be
   cut mechanically downstream, at a word offset with no regard for meaning — so any beat
   you leave oversized is a beat you have handed to a blunt instrument. Segment it yourself.
3. A beat is ONE visual idea. Merge short sentences that share an image.
   A SENTENCE IS NOT A BEAT. One grammatical sentence that names several distinct subjects
   is several visual ideas, and must become several beats — split it at its clause or
   semicolon boundaries, one beat per subject. "There are five fruits you need to rethink:
   grapes …; watermelon …; bananas …; raisins …; and mangoes …" is FIVE beats, not one:
   each fruit is its own shot and its own moment on screen. Grouping them as one beat with
   a single "variety of fruits" visual throws the whole list on screen as one picture.
   Rule 2 wins over any instinct to keep a sentence intact.

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
10. \`entities\` — the concrete things this beat PUTS ON SCREEN.
   This is NOT named-entity recognition. Do not scan for proper nouns; ask of every noun in
   the beat: "could a camera point at this?" If yes, and the beat names it, it is an entity —
   famous or not, proper noun or not, encyclopedic or not.
     "beet juice", "the kidneys", "grapes", "yogurt", "a stethoscope", "an elderly man",
     "the liver", "Elon Musk", "the Dead Sea", "React" — ALL of these are entities.
   The everyday ones are not lesser entities. They are the ones the viewer actually sees.
   BE EXHAUSTIVE. A beat naming five foods has FIVE entities, one per food. A beat about beet
   juice and kidney stones has BOTH. An entity you leave out is a shot the editor cannot plan,
   and that beat falls back to generic stock footage — the exact failure this field prevents.
   Skip ONLY pronouns, connectives, and pure abstractions ("freedom", "many people",
   "the good news").
   WORKED EXAMPLE — "Beet juice is packed with nitrates, which your body converts into nitric
   oxide, a compound that helps relax blood vessels." → THREE entities, none of them famous:
   [{surface:"Beet juice",canonical:"beet juice",category:"food",instanceOf:"vegetable juice",
     disambiguation:"the drink pressed from beetroot",searchTerms:["beet juice glass",
     "fresh beetroot juice"],visualizable:true},
    {surface:"nitric oxide",canonical:"nitric oxide",category:"substance",instanceOf:"chemical
     compound",disambiguation:"the signalling molecule NO",searchTerms:["nitric oxide molecule"],
     visualizable:true},
    {surface:"blood vessels",canonical:"blood vessel",category:"anatomy",instanceOf:"anatomical
     structure",disambiguation:"arteries and veins",searchTerms:["blood vessel cross section",
     "artery illustration"],visualizable:true}]
   For each:
   - \`surface\`: as written in the narration ("the Dead Sea", "ripe bananas with brown spots").
   - \`canonical\`: the plain English name of the thing. For a proper noun ("Dead Sea", "Elon
     Musk", "React") make it exact and disambiguated — we look those up in an encyclopedia.
     For an everyday thing it is simply what you would call it ("grapes", "beet juice").
   - \`category\`: person, country, region, city, landmark, lake, ocean, mountain, river,
     nature, animal, plant, food, anatomy, substance, planet, astro, building, vehicle,
     company, brand, product, software, artwork, book, film, event, concept, object, symbol,
     flag. Use \`object\` or \`concept\` only when nothing more specific fits — they route to
     no specialist archive, so a mis-filed \`object\` is a wasted entity.
   - \`instanceOf\`: the general CLASS, lowercase ("lake", "human", "planet", "vegetable juice",
     "anatomical structure") — we use it to CONFIRM the right thing was linked.
   - \`disambiguation\`: one short clause fixing the sense ("the salt lake in the Middle
     East, not the given name") — essential for ambiguous names (Jordan, Mercury, Amazon).
     For an unambiguous everyday thing, one plain clause is enough.
   - \`searchTerms\`: up to 3 English phrases to find it ("dead sea aerial", "petra jordan").
   - \`visualizable\`: true when there is a real thing to show; false for pure abstractions
     (freedom, inflation, happiness) — those fall back to generic mood b-roll.
11. \`shots\` — you are the VISUAL DIRECTOR of a premium documentary (the b-roll discipline
   of top explainer channels). For each beat design the ordered shots that TELL its story.
   THERE IS NO FIXED NUMBER OF SHOTS. Do not aim for two, or three, or four. The count is
   decided by the beat: design ONE SHOT PER DISTINCT THING THE BEAT PUTS ON SCREEN. Count the
   visualizable entities and the concrete actions, and write that many shots.
     "The apple, mango and yogurt are powerful for old people for their liver." → FIVE shots:
     apple, mango, yogurt, an older person, the liver. Not one "healthy foods" shot, and not
     three because three felt like enough — five things are named, so five things are shown.
   HARD FLOOR: the beat must have AT LEAST as many shots as it has visualizable entities. Every
   entity you listed in \`entities\` must be named by some shot's \`entity\` field. If you list four
   and design one, three of them are never searched at all and the beat falls to generic stock.
   NEVER collapse several named subjects into one summary shot. "a variety of fruits", "assorted
   healthy foods", "doctor discussing health concerns" for a beat that named kidney stones,
   diabetes and blood pressure — these are the single worst failure mode here: the viewer sees
   one vague picture while the narrator names four specific things. A summary shot may be ADDED
   as context, but never INSTEAD of the things themselves.
   The one real limit is screen time — a shot needs about a second to register, so a beat can
   carry roughly one shot per second of its narration. Plan up to that, not beyond; if a beat
   names more things than it has seconds, it is too long and rule 2 says to split it.
   For each shot:
   - \`phrase\`: a concrete, searchable 3–6 word English phrase ("dead sea aerial view",
     "jordan locator map", "apollo 11 moon landing").
   - \`entity\`: the \`canonical\` of the beat entity this shot depicts, or "" for a generic
     mood/action shot with no named subject.
   - \`want\`: the KIND of image needed — portrait (a person), flag (a country's flag), map
     (a locator/where-is-it map), aerial (top-down or wide land), logo (a company/brand/
     software mark), footage (archival or action video of the subject), scene (a normal
     photo of the subject), or generic (no named subject).
   - \`weight\`: relative on-screen time, 1–3 (a hero shot gets more). A rapid list gives every
     item the same weight; a beat with one hero subject and supporting detail does not.
   Compose the story: countries and regions → a flag and/or a map plus a scene; people → a
   portrait plus footage; planets/space → scene or footage. Prefer a sequence of precise
   STILLS (slow zoom) over one generic video.
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

// Pass 1 of two (doc 07 §two-pass): read the whole script, commit to its subject and cast.
// Deliberately cheap and small — its only job is to give pass 2 the context a chunk cannot see.
const BRIEF_PROMPT = `You are preparing a script for an automated documentary editor. Read the
ENTIRE script and answer what it is about, as a whole.

- \`subject\`: one clause naming what the script is about ("the Voyager 1 mission and its
  golden record", "how beet juice interacts with common foods after age 60").
- \`topic\`: the single dominant domain, lowercase — space, medicine, ocean, weather, nature,
  earth, history, art, science, engineering, technology, transport, food, urban, people,
  business, education, travel, or generic.
- \`era\`: the period the script's visuals should evoke overall — "modern", "historical", or
  "timeless" (nature, space, abstract). When the script spans eras, pick the dominant one.
- \`cast\`: the entities that RECUR across the script, by canonical English name ("Voyager 1",
  "NASA", "Carl Sagan" / "beet juice", "kidneys"). This is what lets a later passage that says
  only "the spacecraft" or "it" be linked back to the thing it means. Name everything a viewer
  would recognise as a running subject; skip one-off mentions.
- \`language\`: the script's language (en-US, en-GB, es, fr, hi, it, pt-BR, ja, zh).
- \`musicMood\`: one overall bed for the finished video — uplifting, calm, corporate,
  emotional, energetic, tense, or none.

Return ONLY JSON matching the provided schema.`;

export function buildBriefPrompt(): string {
  return BRIEF_PROMPT;
}

// Pass 2's view of pass 1. Injected into EVERY chunk's user message, so a beat in chunk 3 knows
// the script's subject and can resolve "the spacecraft" against the cast list.
export function formatBriefContext(brief: ScriptBrief): string {
  const cast = brief.cast.length > 0 ? brief.cast.join(', ') : 'none identified';
  return [
    'WHOLE-SCRIPT CONTEXT (you are segmenting one part of a longer script; this describes all of it):',
    `- Subject: ${brief.subject}`,
    `- Topic: ${brief.topic}`,
    `- Overall era: ${brief.era}`,
    `- Recurring cast: ${cast}`,
    'Use the cast to resolve pronouns and bare references ("the spacecraft", "it", "this drink")',
    'back to the entity they mean, and list that entity on the beat even when the beat does not',
    'spell out its name.',
  ].join('\n');
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
// shot phrases. NOT truncated — this used to `.slice(0, 4)`, which silently dropped the
// fifth food of a five-food beat *after* the analyzer had correctly planned it, since
// visual_moments (not shots) is what score reads to build the montage. How many segments
// actually fit is a question about screen time, and it is answered in planSemanticMontage
// where the beat duration is known.
function deriveMoments(shots: Shot[]): string[] {
  return shots.map((s) => s.phrase);
}

// Every visualizable entity the beat names must be depicted by some shot.
//
// This is a floor, not a preference, because the shot plan is the ONLY route from an entity to
// a search: the search stage walks `shots` and resolves `shot.entity`, so an entity no shot
// points at is never sent to Wikidata, never knowledge-expanded, never given an authoritative
// source — it costs an LLM call and does nothing. Rule 11 asks the model for this, and the
// model still collapses: measured on gpt-4o, a beat naming kidney stones, diabetes, kidney
// disease and blood pressure got ONE "doctor discussing health concerns" shot, so all four
// entities were inert and the beat fell to generic stock.
//
// So an undepicted entity gets a shot built from its own searchTerms and its category's natural
// want. These are the model's own words for the thing, just not arranged as a shot. How many of
// them reach the screen is still bounded by screen time, downstream in planSemanticMontage.
function ensureEntityShots(beat: ProcessedBeat): ProcessedBeat {
  const depicted = new Set(
    beat.shots.map((s) => s.entity.toLowerCase()).filter((e) => e.length > 0),
  );
  const missing = beat.entities.filter(
    (e) => e.visualizable && !depicted.has(e.canonical.toLowerCase()),
  );
  if (missing.length === 0) return beat;
  const added: Shot[] = missing.map((e) => ({
    phrase: e.searchTerms[0] ?? e.canonical,
    entity: e.canonical,
    want: CATEGORY_DEFAULT_WANT[e.category],
    weight: 1,
  }));
  const shots = [...beat.shots, ...added].slice(0, MAX_SHOTS_PER_BEAT);
  return { ...beat, shots, visualMoments: deriveMoments(shots) };
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
  return out.slice(0, MAX_ENTITIES_PER_BEAT);
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
    const mergedShots = [...first.shots, ...second.shots].slice(0, MAX_SHOTS_PER_BEAT);
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
// Which of a parent beat's shots belong to this half of a split, by what the half actually SAYS.
//
// A split reshapes the sentence, so the parent's plan does not apply wholesale to either half — but
// it is not worthless either: "grapes and watermelon on table" belongs to whichever half contains
// the word "grapes". Blanking both halves threw away a correct plan and left every child sharing the
// parent's one visualDescription, so N consecutive beats fetched the SAME asset. Measured on a real
// gpt-4o run: it designed 3 shots for the five-fruit sentence (grapes+watermelon / bananas / dried
// fruits+mangoes); the sentence split into 4 beats and all 4 shipped `shots: []` with an identical
// description — one video where the model had planned a montage.
//
// Match on the shot's `entity` when it has one (a canonical name is the stable key), else on the
// content words of its `phrase`. Short words are skipped so "of"/"on"/"the" cannot match everything.
// A shot naming nothing in either half is dropped rather than guessed at — a wrong shot is worse
// than a generic one, since the ladder can still find something for a bare visualDescription.
function shotsForHalf(shots: readonly Shot[], half: string): Shot[] {
  const hay = half.toLowerCase();
  return shots.filter((s) => {
    const needle = (s.entity || s.phrase).toLowerCase();
    const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    return words.length > 0 && words.some((w) => hay.includes(w));
  });
}

// Build one half of a split beat.
//
// `shots` were already re-homed by shotsForHalf, but `visualDescription` and the literal
// queries were not — both halves inherited the parent's, which described the WHOLE sentence.
// That points each half at the other's content: the head of "…NASA commanded Voyager to turn
// around one last time. From six billion km away it captured Earth…" narrated the turn-around
// while carrying visualDescription "Earth as a pale blue dot" and searching "earth pale blue
// dot". visualDescription is the beat's semantic anchor for scoring, so a stapled one misscores
// every candidate — and giving both halves the same anchor makes them fight over one asset.
//
// A half's visuals come from the shots it actually kept. A half that kept none falls back to
// the beat-level conceptual/mood tiers: vague, but they describe the idea rather than either
// span, so they cannot be wrong about WHICH half they belong to.
function halfBeat(
  parent: ProcessedBeat,
  text: string,
  language: string,
  speed: number,
): ProcessedBeat {
  const shots = shotsForHalf(parent.shots, text);
  const estSeconds = estimateSeconds(text, language, speed);
  const { conceptual, mood } = parent.queries;

  // Entities follow their shots, for the same reason the shots follow the text. A half that
  // kept the grapes shot is about grapes; one that did not is not, and claiming otherwise skews
  // its topic routing and shows the storyboard a subject that half never mentions. Non-
  // visualizable entities have no shot to follow, so they are matched on `surface` — which is
  // by definition the wording the narration used.
  const depicted = new Set(shots.map((s) => s.entity.toLowerCase()).filter((e) => e.length > 0));
  const hay = text.toLowerCase();
  const entities = parent.entities.filter(
    (e) => depicted.has(e.canonical.toLowerCase()) || hay.includes(e.surface.toLowerCase()),
  );

  if (shots.length === 0) {
    return {
      ...parent,
      text,
      entities,
      shots: [],
      visualMoments: [],
      visualDescription: conceptual,
      queries: { ...parent.queries, literal: [conceptual, mood] },
      estSeconds,
    };
  }
  const phrases = shots.map((s) => s.phrase);
  return {
    ...parent,
    text,
    entities,
    shots,
    visualMoments: phrases,
    visualDescription: phrases.join(', ').slice(0, 160),
    queries: { ...parent.queries, literal: [phrases[0] ?? conceptual, phrases[1] ?? conceptual] },
    estSeconds,
  };
}

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
      next.push(halfBeat(beat, split[0], language, speed));
      next.push(halfBeat(beat, split[1], language, speed));
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
//
// The demotion used to rewrite each slot independently, so when BOTH literals repeated the
// previous beat both became `conceptual` — two identical tier-1 queries, which fire the same
// search twice and halve the beat's candidate pool. Observed on a real gpt-4o run as
// `literal: ["our place in universe", "our place in universe"]`, and it landed on precisely
// the split-tail beats that were already the weakest.
//
// So: prefer a query that repeats neither this beat's other slot nor the previous beat's;
// failing that, keep the two slots DISTINCT from each other. Cross-beat repetition merely
// wastes provider quota, but an in-beat repeat wastes half the pool — the stronger constraint
// wins when they conflict.
export function queryHygiene(beats: ProcessedBeat[]): ProcessedBeat[] {
  const out: ProcessedBeat[] = [];
  let previous = new Set<string>();
  for (const beat of beats) {
    const conceptual = normalizeQuery(beat.queries.conceptual);
    const mood = normalizeQuery(beat.queries.mood);
    const literal: string[] = [];
    for (const raw of beat.queries.literal) {
      const options = [normalizeQuery(raw), conceptual, mood].filter((q) => q.length > 0);
      const fresh = options.find((q) => !literal.includes(q) && !previous.has(q));
      const distinct = options.find((q) => !literal.includes(q));
      literal.push(fresh ?? distinct ?? options[0] ?? conceptual);
    }
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

  // Order matters. ensureEntityShots runs FIRST so the shots it derives are re-homed by
  // splitLongBeats like any other — a derived "earth pale blue dot" shot lands on the half that
  // says "Earth", exactly as a model-authored one would. Running it after the split would
  // instead see both halves inheriting the parent's full entity list and invent shots for things
  // that half never mentions.
  const withEntityShots = processed.map(ensureEntityShots);
  const merged = mergeShortBeats(withEntityShots, input.language, input.speed);
  const split = splitLongBeats(merged, input.language, input.speed);
  const hygiened = queryHygiene(split).map((beat, idx) => ({ ...beat, idx }));

  return {
    beats: hygiened,
    language: input.language,
    musicMood: input.result.musicMood,
    reconstruction,
  };
}
