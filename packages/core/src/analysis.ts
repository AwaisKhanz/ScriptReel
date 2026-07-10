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

export const MusicMoodSchema = z.enum([
  'uplifting',
  'calm',
  'corporate',
  'emotional',
  'energetic',
  'tense',
  'none',
]);

export const BeatSchema = z.object({
  text: z.string().min(1), // VERBATIM slice of the script
  visualDescription: z.string().max(160), // English, filmable
  keyPhrase: z.string().max(48), // ≤6 words, script language
  emotion: EmotionSchema,
  shotType: ShotTypeSchema,
  entities: z.object({
    people: z.string().array(),
    places: z.string().array(),
    objects: z.string().array(),
  }),
  queries: z.object({
    literal: z.string().array().length(2), // tier 1 — concrete
    conceptual: z.string(), // tier 2 — the idea
    mood: z.string(), // tier 3 — atmosphere
  }),
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
5. NEVER use real people's names, brand names, or logos in visualDescription or
   queries. Replace with generic roles: "Elon Musk" → "tech CEO speaking on stage".
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
  entities: Beat['entities'];
  queries: { literal: string[]; conceptual: string; mood: string };
  estSeconds: number;
}

export interface PostProcessInput {
  script: string;
  result: AnalysisResult;
  language: string;
  speed: number;
}

export interface PostProcessOutput {
  beats: ProcessedBeat[];
  language: string;
  musicMood: AnalysisResult['musicMood'];
  reconstruction: 'exact' | 'repaired';
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

// Anchor-repair first (best boundaries); proportional fallback guarantees verbatim.
export function repairVerbatim(script: string, beats: Beat[]): Beat[] | null {
  const anchored = repairByAnchors(script, beats);
  if (anchored) return anchored;
  const proportional = repairProportional(script, beats);
  return reconstructionMatches(script, proportional) ? proportional : null;
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
    const merged: ProcessedBeat = {
      ...longer,
      text,
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
        estSeconds: estimateSeconds(split[0], language, speed),
      });
      next.push({
        ...beat,
        text: split[1],
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
  let reconstruction: 'exact' | 'repaired' = 'exact';

  if (!reconstructionMatches(input.script, beats)) {
    const repaired = repairVerbatim(input.script, beats);
    if (!repaired) {
      throw new PipelineError(
        'E_LLM_SCHEMA',
        'analyze',
        'verbatim reconstruction failed after repair',
      );
    }
    beats = repaired;
    reconstruction = 'repaired';
  }

  const processed: ProcessedBeat[] = beats.map((beat, idx) => ({
    idx,
    text: beat.text,
    visualDescription: beat.visualDescription,
    keyPhrase: beat.keyPhrase,
    emotion: beat.emotion,
    shotType: beat.shotType,
    entities: beat.entities,
    queries: {
      literal: [...beat.queries.literal],
      conceptual: beat.queries.conceptual,
      mood: beat.queries.mood,
    },
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
