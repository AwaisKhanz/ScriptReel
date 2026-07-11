import { env } from '@scriptreel/config';
import {
  type AnalysisResult,
  AnalysisResultSchema,
  type AnalyzeInput,
  type AnalyzeOptions,
  buildSystemPrompt,
  PipelineError,
  type ScriptAnalyzer,
} from '@scriptreel/core';
import OpenAI from 'openai';
import type { Logger } from 'pino';

const MAX_CHUNK_WORDS = 1200;

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
          'entities',
          'queries',
          'visualMoments',
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
          entities: {
            type: 'object',
            additionalProperties: false,
            required: ['people', 'places', 'objects'],
            properties: {
              people: { type: 'array', items: { type: 'string' } },
              places: { type: 'array', items: { type: 'string' } },
              objects: { type: 'array', items: { type: 'string' } },
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
          // Ordered montage sub-phrases (doc 23 §7b). Strict mode rejects fields not
          // listed here, so omitting this silently disabled the semantic montage.
          visualMoments: { type: 'array', items: { type: 'string' } },
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
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new PipelineError('E_ENV', 'analyze', 'OPENAI_API_KEY is not set');
    }
    this.client = new OpenAI({ apiKey, maxRetries: 3 }); // SDK backs off on 429/5xx
    this.model = env.OPENAI_MODEL;
    this.log = log;
  }

  async analyze(input: AnalyzeInput, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const chunks = chunkScript(input.script, MAX_CHUNK_WORDS);
    if (chunks.length === 1) {
      const only = chunks[0] ?? input.script;
      return this.analyzeChunk(input, only, undefined, opts);
    }

    const beats: AnalysisResult['beats'] = [];
    let language = input.languageHint ?? 'en-US';
    let musicMood: AnalysisResult['musicMood'] = 'none';
    for (const chunk of chunks) {
      const context =
        beats.length > 0
          ? `Previous beat count: ${beats.length}. Continue segmentation; maintain shot variety with previous shotType: ${beats.at(-1)?.shotType ?? 'wide'}.`
          : undefined;
      const part = await this.analyzeChunk(input, chunk, context, opts);
      beats.push(...part.beats);
      language = part.language;
      musicMood = part.musicMood;
    }
    return { language, musicMood, beats };
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
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'analysis', strict: true, schema: RESPONSE_JSON_SCHEMA },
        },
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new PipelineError(
        'E_LLM_QUOTA',
        'analyze',
        `openai request failed (status ${status ?? 'n/a'})`,
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
      json = JSON.parse(content);
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
