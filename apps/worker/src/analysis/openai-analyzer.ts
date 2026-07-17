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
import { extractJsonObject, getLlm, jsonFormat } from './llm';

const MAX_CHUNK_WORDS = 1200;

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
    const chunks = chunkScript(input.script, MAX_CHUNK_WORDS);

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
      const completion = await this.client.chat.completions.create({
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
      });
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
      completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: buildSystemPrompt(input.pacing) },
          { role: 'user', content: user },
        ],
        response_format: jsonFormat('analysis', RESPONSE_JSON_SCHEMA),
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new PipelineError(
        'E_LLM_QUOTA',
        'analyze',
        `LLM request failed (${this.model}, status ${status ?? 'n/a'})`,
        {
          cause: err,
        },
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
