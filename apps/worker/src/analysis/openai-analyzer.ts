import { env } from '@scriptreel/config';
import {
  type AnalysisResult,
  AnalysisResultSchema,
  type AnalyzeInput,
  type AnalyzeOptions,
  buildBriefPrompt,
  buildSystemPrompt,
  formatBriefContext,
  PipelineError,
  type ScriptAnalyzer,
  type ScriptBrief,
  ScriptBriefSchema,
} from '@scriptreel/core';
import type OpenAI from 'openai';
import type { Logger } from 'pino';
import { extractJsonObject, getLlm, jsonFormat, type LlmProvider } from './llm';

// Chunk size + request timeout per provider — the same lesson media-verifier.ts learned for
// images, applied to text: a hosted API and a local model are not the same machine, and a request
// that exceeds the window "was never servable, at any timeout".
//
// A beat expands to roughly 12x its script words in JSON (verbatim text + visualDescription +
// keyPhrase + entities + shots + queries), and analyze must emit a whole chunk's beats in ONE
// response. gpt-4o has a 128k window at ~100 tok/s, so 1200 words is one fast call. Measured on
// the owner's RTX 5060 Ti with OLLAMA_CONTEXT_LENGTH=16384: qwen2.5-coder:14b runs at 41.7 tok/s,
// so a 1200-word chunk demands ~13.7k output tokens on top of ~3k input — ~16.7k against a 16,384
// window. It does not fit, and Ollama drops the overflow SILENTLY rather than erroring: measured
// 2026-07-16, a 295-word script came back as 185 words of beats (37% dropped) and the model was
// blamed. At 5.5 min of generation it also outruns any sane request timeout. 500 words keeps a
// chunk near ~8k tokens — half the window — and ~2 min per call.
//
// This does NOT make a local run faster: total generation is ~12 tokens per script word either
// way (a 2,278-word script is ~11 min on this box). It makes each call FIT and SURVIVE.
const LIMITS: Record<LlmProvider, { maxChunkWords: number; timeoutMs: number }> = {
  openai: { maxChunkWords: 1200, timeoutMs: 300_000 },
  ollama: { maxChunkWords: 500, timeoutMs: 300_000 },
};

// An LLM error with no HTTP status never reached the model. Which way it failed is the whole
// diagnosis — "the server is off" and "the server is too slow" have nothing in common — and
// `status n/a` says neither.
function describeTransport(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed? out|ETIMEDOUT/i.test(msg)) {
    return `request timed out after ${LIMITS[getLlm().provider].timeoutMs / 1000}s`;
  }
  if (/ECONNREFUSED|Connection error|fetch failed/i.test(msg)) {
    return `cannot reach ${getLlm().provider === 'ollama' ? env.OLLAMA_BASE_URL : 'the OpenAI API'}`;
  }
  return msg.slice(0, 80);
}

// Mirrors ScriptBriefSchema for structured outputs (same subset rules as RESPONSE_JSON_SCHEMA
// below — zod stays the source of truth and validates after parsing).
const BRIEF_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'topic', 'era', 'cast', 'language', 'musicMood'],
  properties: {
    subject: { type: 'string' },
    topic: { type: 'string' },
    era: { type: 'string', enum: ['modern', 'historical', 'timeless'] },
    cast: { type: 'array', items: { type: 'string' } },
    language: { type: 'string' },
    musicMood: {
      type: 'string',
      enum: ['uplifting', 'calm', 'corporate', 'emotional', 'energetic', 'tense', 'none'],
    },
  },
};

// JSON Schema mirroring AnalysisResultSchema in the subset OpenAI structured outputs
// (strict) accepts — no length/min/max keywords (those live in the zod schema, which
// validates after parsing). The zod schema stays the source of truth.
const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'musicMood', 'beats'],
  properties: {
    language: { type: 'string' },
    musicMood: {
      type: 'string',
      enum: ['uplifting', 'calm', 'corporate', 'emotional', 'energetic', 'tense', 'none'],
    },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'text',
          'visualDescription',
          'keyPhrase',
          'emotion',
          'shotType',
          'era',
          'entities',
          'queries',
          'shots',
        ],
        properties: {
          text: { type: 'string' },
          visualDescription: { type: 'string' },
          keyPhrase: { type: 'string' },
          emotion: {
            type: 'string',
            enum: [
              'neutral',
              'uplifting',
              'serious',
              'tense',
              'sad',
              'exciting',
              'calm',
              'inspiring',
            ],
          },
          shotType: {
            type: 'string',
            enum: ['wide', 'medium', 'close', 'detail', 'aerial', 'abstract'],
          },
          era: {
            type: 'string',
            enum: ['modern', 'historical', 'timeless'],
          },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'surface',
                'canonical',
                'category',
                'instanceOf',
                'disambiguation',
                'searchTerms',
                'visualizable',
              ],
              properties: {
                surface: { type: 'string' },
                canonical: { type: 'string' },
                category: {
                  type: 'string',
                  enum: [
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
                    'plant',
                    'food',
                    'anatomy',
                    'substance',
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
                  ],
                },
                instanceOf: { type: 'string' },
                disambiguation: { type: 'string' },
                searchTerms: { type: 'array', items: { type: 'string' } },
                visualizable: { type: 'boolean' },
              },
            },
          },
          queries: {
            type: 'object',
            additionalProperties: false,
            required: ['literal', 'conceptual', 'mood'],
            properties: {
              literal: { type: 'array', items: { type: 'string' } },
              conceptual: { type: 'string' },
              mood: { type: 'string' },
            },
          },
          // Typed visual plan (doc 24 §3). Strict mode rejects fields not listed here —
          // omitting a property silently disables that part of the pipeline (this bit us
          // once with visualMoments), so entity + shot fields must all be present.
          shots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['phrase', 'entity', 'want', 'weight'],
              properties: {
                phrase: { type: 'string' },
                entity: { type: 'string' },
                want: {
                  type: 'string',
                  enum: [
                    'portrait',
                    'flag',
                    'map',
                    'aerial',
                    'logo',
                    'footage',
                    'scene',
                    'generic',
                  ],
                },
                weight: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
};

function chunkScript(script: string, maxWords: number): string[] {
  const trimmed = script.trim();
  if (trimmed.split(/\s+/).length <= maxWords) return [trimmed];
  const chunks: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const para of trimmed.split(/\n\s*\n/)) {
    const paraWords = para.trim().split(/\s+/).length;
    if (count + paraWords > maxWords && current.length > 0) {
      chunks.push(current.join('\n\n'));
      current = [];
      count = 0;
    }
    current.push(para.trim());
    count += paraWords;
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

export class OpenAiAnalyzer implements ScriptAnalyzer {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly log: Logger;

  constructor(log: Logger) {
    // Provider (OpenAI cloud or local Ollama) resolved centrally — this analyzer is provider-
    // agnostic since both speak the OpenAI chat API.
    const llm = getLlm();
    if (!llm.available) {
      throw new PipelineError(
        'E_ENV',
        'analyze',
        'no LLM configured — set OPENAI_API_KEY, or LLM_PROVIDER=ollama for a local model',
      );
    }
    this.client = llm.client;
    this.model = llm.textModel;
    this.log = log;
  }

  // Two passes (doc 07 §two-pass). Pass 1 reads the WHOLE script once and commits to its
  // subject, era, recurring cast, language and music mood. Pass 2 segments, with that brief in
  // front of every chunk — so a beat saying only "the spacecraft" can still name Voyager 1, and
  // the whole-script answers come from the whole script rather than from whichever chunk ran last.
  async analyze(input: AnalyzeInput, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const brief = await this.brief(input);
    const briefContext = brief ? formatBriefContext(brief) : undefined;
    const chunks = chunkScript(input.script, LIMITS[getLlm().provider].maxChunkWords);

    const beats: AnalysisResult['beats'] = [];
    let language = brief?.language ?? input.languageHint ?? 'en-US';
    let musicMood: AnalysisResult['musicMood'] = brief?.musicMood ?? 'none';
    for (const chunk of chunks) {
      const continuation =
        beats.length > 0
          ? `Previous beat count: ${beats.length}. Continue segmentation; maintain shot variety with previous shotType: ${beats.at(-1)?.shotType ?? 'wide'}.`
          : undefined;
      const context = [briefContext, continuation].filter(Boolean).join('\n\n') || undefined;
      const part = await this.analyzeChunk(input, chunk, context, opts);
      beats.push(...part.beats);
      // Only trust a chunk's whole-script fields when pass 1 didn't answer them.
      if (!brief) {
        language = part.language;
        musicMood = part.musicMood;
      }
    }
    return { language, musicMood, beats };
  }

  // Pass 1. Degrades to null rather than throwing — a missing brief costs cross-chunk context,
  // which is worse analysis but not a failed project (invariant 7).
  private async brief(input: AnalyzeInput): Promise<ScriptBrief | null> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: buildBriefPrompt() },
            {
              role: 'user',
              content: [
                input.languageHint ? `Script language hint: ${input.languageHint}.` : '',
                'SCRIPT:',
                input.script,
              ]
                .filter((p) => p.length > 0)
                .join('\n\n'),
            },
          ],
          response_format: jsonFormat('brief', BRIEF_JSON_SCHEMA),
        },
        { timeout: LIMITS[getLlm().provider].timeoutMs },
      );
      const content = completion.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = ScriptBriefSchema.safeParse(JSON.parse(extractJsonObject(content)));
      if (!parsed.success) {
        this.log.warn({ model: this.model }, 'script brief failed schema — segmenting without it');
        return null;
      }
      this.log.debug({ subject: parsed.data.subject, cast: parsed.data.cast }, 'script brief');
      return parsed.data;
    } catch (err) {
      this.log.warn({ err }, 'script brief call failed — segmenting without it');
      return null;
    }
  }

  private async analyzeChunk(
    input: AnalyzeInput,
    chunk: string,
    chunkContext: string | undefined,
    opts: AnalyzeOptions,
  ): Promise<AnalysisResult> {
    const user = [
      input.languageHint ? `Script language hint: ${input.languageHint}.` : '',
      chunkContext ?? '',
      opts.retryHint
        ? `IMPORTANT — your previous attempt was rejected: ${opts.retryHint} Return corrected JSON.`
        : '',
      'SCRIPT:',
      chunk,
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.model,
          temperature: 0.3,
          messages: [
            { role: 'system', content: buildSystemPrompt(input.pacing) },
            { role: 'user', content: user },
          ],
          response_format: jsonFormat('analysis', RESPONSE_JSON_SCHEMA),
        },
        // Explicit, provider-sized. Without it the SDK's own default applies (× maxRetries), which
        // is neither tuned to a local model's token rate nor visible to anyone reading this file.
        { timeout: LIMITS[getLlm().provider].timeoutMs },
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      // Not every LLM failure is a quota problem. E_LLM_QUOTA is in errors.ts's RETRYABLE set, so
      // reporting EVERY error as one makes an unfixable config mistake cost three full attempts
      // and then fail naming the wrong cause: an un-pulled OLLAMA_MODEL (404) or a bad key (401)
      // can never succeed on retry. A 4xx that is not 429 is configuration → E_ENV, which is not
      // retryable. 429 / 5xx / timeout / connection stay E_LLM_QUOTA — those really are transient.
      const config = status !== undefined && status >= 400 && status < 500 && status !== 429;
      // `status` is undefined for a timeout or a refused connection, and "status n/a" tells the
      // reader nothing — say which it was, since the two have completely different fixes.
      const cause = status !== undefined ? `status ${status}` : describeTransport(err);
      throw new PipelineError(
        config ? 'E_ENV' : 'E_LLM_QUOTA',
        'analyze',
        `LLM request failed (${this.model}, ${cause})`,
        { cause: err },
      );
    }

    const message = completion.choices[0]?.message;
    if (message?.refusal) {
      throw new PipelineError('E_LLM_SCHEMA', 'analyze', `model refused: ${message.refusal}`);
    }
    const content = message?.content;
    if (!content) {
      throw new PipelineError('E_LLM_SCHEMA', 'analyze', 'empty model response');
    }

    let json: unknown;
    try {
      // extractJsonObject strips any <think> block / stray prose a local model may emit.
      json = JSON.parse(extractJsonObject(content));
    } catch {
      throw new PipelineError('E_LLM_SCHEMA', 'analyze', 'response was not valid JSON');
    }
    const parsed = AnalysisResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new PipelineError(
        'E_LLM_SCHEMA',
        'analyze',
        `analysis schema invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    this.log.debug(
      { beats: parsed.data.beats.length, model: this.model },
      'openai analysis parsed',
    );
    return parsed.data;
  }
}
