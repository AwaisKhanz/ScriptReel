# 07 — Script Analysis (Beat Segmentation)

## Goal

Turn the raw script into an ordered list of **visual beats** — the atomic unit of the whole system. A beat is a contiguous verbatim slice of the script that shares one visual idea and will map to one media asset. Beats target 4–10 s of narration (pacing-adjusted); **never** naive sentence splitting.

> **Stack change — 2026-07-10:** the analyzer is **OpenAI GPT only** (`OpenAiAnalyzer`, OpenAI SDK structured outputs, env `OPENAI_API_KEY` / `OPENAI_MODEL`). The Gemini and Ollama analyzers are removed — ignore Gemini/Ollama references throughout this doc.

## Interface

```ts
interface ScriptAnalyzer {
  analyze(input: { script: string; languageHint?: string; pacing: Pacing }): Promise<AnalysisResult>;
}
// Implementations: GeminiAnalyzer (structured output / responseSchema, temperature 0.3),
// OllamaAnalyzer (format: json, same schema). Selected by env LLM_PROVIDER.
```

## Output schema (zod — single source of truth in `packages/core/src/analysis.ts`)

```ts
const Emotion = z.enum(['neutral','uplifting','serious','tense','sad','exciting','calm','inspiring']);
const ShotType = z.enum(['wide','medium','close','detail','aerial','abstract']);

const Beat = z.object({
  text: z.string().min(1),                    // VERBATIM slice of the script
  visualDescription: z.string().max(160),     // English. What the viewer literally sees
  keyPhrase: z.string().max(48),              // ≤6 words, script language — used for text cards
  emotion: Emotion,
  shotType: ShotType,
  entities: z.object({ people: z.string().array(), places: z.string().array(), objects: z.string().array() }),
  queries: z.object({
    literal: z.string().array().length(2),    // tier 1 — concrete, 1–4 words each
    conceptual: z.string(),                   // tier 2 — the idea, not the words
    mood: z.string(),                         // tier 3 — atmosphere/texture
  }),
});
const AnalysisResult = z.object({
  language: z.string(),                       // detected: en-US|en-GB|es|fr|hi|it|pt-BR|ja|zh
  musicMood: z.enum(['uplifting','calm','corporate','emotional','energetic','tense','none']),
  beats: Beat.array().min(1),
});
```

## System prompt (verbatim; `{PACING_RULE}` substituted)

```
You segment scripts into VISUAL BEATS for an automated video editor, and you design
what the viewer should SEE during each beat.

RULES — SEGMENTATION
1. Beats must reproduce the input script EXACTLY when their `text` fields are
   concatenated in order. Never rewrite, translate, drop, or add words. Preserve
   punctuation. Only leading/trailing whitespace between beats may be normalized.
2. {PACING_RULE}  (e.g. "Target 12–20 spoken words per beat.")
3. A beat is ONE visual idea. Merge short sentences that share an image. Split long
   sentences at natural clause boundaries when the imagery changes.

RULES — VISUAL DESIGN
4. `visualDescription` is ALWAYS ENGLISH, ≤ 20 words, and FILMABLE: describe a shot a
   stock-video camera could capture — subjects, setting, action, lighting. Never
   abstract claims ("revenue grew"), never on-screen text, charts with specific
   numbers, or captions. Translate ideas into imagery: "revenue grew 40%" →
   "upward trending line graph on laptop screen, modern office, confident team".
5. NEVER use real people's names, brand names, or logos in visualDescription or
   queries. Replace with generic roles: "Elon Musk" → "tech CEO speaking on stage".
6. `queries`: ALWAYS ENGLISH, lowercase, 1–4 words, no punctuation.
   - literal[0]: the most concrete subject+context ("rusty farm gate dusk")
   - literal[1]: a different concrete angle of the same idea
   - conceptual: the underlying concept ("hesitation choice")→ as searchable nouns
     ("person standing crossroads")
   - mood: pure atmosphere matching the emotion ("moody countryside sunset")
7. Vary `shotType` across consecutive beats when plausible; avoid three identical in a row.
8. `keyPhrase`: the beat's essence in ≤ 6 words, in the SCRIPT'S language, suitable
   for a bold on-screen card.
9. Detect `language` of the script (en-US, en-GB, es, fr, hi, it, pt-BR, ja, zh) and
   an overall `musicMood`.

Return ONLY JSON matching the provided schema.
```

Pacing rules: fast → "Target 8–13 spoken words per beat.", normal → "Target 12–20.", slow → "Target 18–28." (≈150–170 wpm English; CJK guidance appended: "For Japanese/Chinese target 18–30 characters (fast), 25–45 (normal), 40–65 (slow) per beat.")

## Two-pass (brief → beats)

**Pass 1 — the brief.** One cheap call reads the **entire** script and returns `ScriptBrief`: `subject`, `topic`, `era`, `cast` (recurring entities, canonical names), `language`, `musicMood`. Degrades to `null` on any failure — segmentation proceeds without it (invariant 7).

**Pass 2 — segmentation.** Scripts > 1,200 words split on paragraph boundaries into ≤ 1,200-word chunks, called sequentially. Every chunk's user message carries `formatBriefContext(brief)` **plus** `Previous beat count: N. Continue segmentation; maintain shot variety with previous shotType: X.`

Why pass 1 exists: a chunk was all the model ever saw. Chunk 2 did not know chunk 1 had introduced Voyager 1, so a later "the spacecraft" resolved to nothing and the beat fell to generic stock. And `language`/`musicMood` are whole-script properties that were answered per chunk, with each chunk overwriting the last — so the music bed came from whichever chunk happened to be final. Both now come from the brief.

## Shot count — the analyzer decides, the post-pass guarantees

There is **no target shot count**. The prompt asks for one shot per distinct thing the beat puts on screen; `MAX_SHOTS_PER_BEAT` / `MAX_ENTITIES_PER_BEAT` (12) are sanity bounds on a malformed response, not targets. `deriveMoments` does **not** truncate.

**`ensureEntityShots` is the floor.** The search stage walks `shots` and resolves `shot.entity` — so an entity no shot points at is never sent to Wikidata, never knowledge-expanded, never given an authoritative source. Measured on gpt-4o: a beat naming kidney stones, diabetes, kidney disease and blood pressure got one *"doctor discussing health concerns"* shot, leaving four entities inert. The post-pass therefore derives a shot (from the entity's own `searchTerms` + `CATEGORY_DEFAULT_WANT[category]`) for every **visualizable** entity the model left undepicted. It runs **before** merge/split so those shots are re-homed by `shotsForHalf` like any other.

How many reach the screen is a screen-time question, answered in `planSemanticMontage` at `MONTAGE_HARD_MIN_SEG_SEC` — not by truncating the plan.

## Measuring it

`pnpm eval:analyze [G8 G9 G10]` runs the real analyzer over golden scripts and reports entities/beat, shots/beat, categories used, and the defect counters (entities with no shot, duplicate tier-1 queries, oversized beats). It asserts nothing — it exists so a prompt edit can be compared against numbers instead of vibes.

## Deterministic post-pass (worker, after LLM)

1. **Verbatim check:** normalize whitespace; `join(beats.text) === normalize(script)` (`reconstruction: 'exact'`) else attempt repair by re-slicing the script using each beat's first 4 words as anchors (`'anchored'`). A model that *summarizes* rather than segments defeats the anchors, and the last-resort re-slice by word-count proportion (`'proportional'`) rebuilds the text while leaving every beat holding visuals designed for a different span — so `postProcessAnalysis` **rejects it** with `PipelineError('E_LLM_SCHEMA', 'analyze')` unless the caller passes `allowProportional`. That rejection is what triggers the single verbatim reprompt; the reprompt itself sets `allowProportional` (invariant 7 — degrade, never die) and the stage records a manifest **warning** so a `'proportional'` ship is never silent.
2. **Duration estimate:** `estSeconds = words / (baseWps(language) * speed)` (doc 10 table). CJK uses chars-based rate.
3. **Merge** any beat with `estSeconds < 2.5` into its shorter neighbor (concatenate text, keep the longer beat's visuals, re-index).
4. **Split** any beat with `estSeconds > 12` at the sentence/clause boundary nearest its midpoint. A half gets only the shots its own text names (`shotsForHalf`), and its `visualDescription` + `literal` queries are **rebuilt from those shots** — not inherited. The parent's described the whole sentence, so inheriting it pointed each half at the other's content: the half narrating *"NASA commanded Voyager to turn around"* was scored against, and searching for, *"earth pale blue dot"*. A half that names no shot falls back to the beat-level `conceptual`/`mood` tiers, which describe the idea rather than either span.
5. **Query hygiene:** lowercase, strip punctuation, and demote a tier-1 query that repeats the previous beat's to the conceptual tier. The two literal slots must stay **distinct from each other** — when both repeated, rewriting each independently made both `conceptual`, firing one search twice and halving the beat's pool (seen as `["our place in universe", "our place in universe"]`). In-beat distinctness wins over cross-beat freshness when they conflict: the former wastes half the pool, the latter only wastes quota.
6. Persist beats rows + `stages/analyze/beats.json` (includes raw LLM response for audit).

## Failure & fallback

Gemini 429/network → exponential backoff (respect free-tier RPM); after retries, if `OLLAMA_MODEL` configured, fall back automatically and tag manifest `analyzer: 'ollama'`. Schema-invalid JSON → one reprompt with validation errors inlined, then fail with `E_LLM_SCHEMA`.

## Quality bar (Phase 2 exit)

On the golden set (doc 21): verbatim reconstruction 100%; ≥ 90% of beats within pacing band after post-pass; zero brand/person names in queries; spot-check 20 visualDescriptions — all filmable by the rubric.
