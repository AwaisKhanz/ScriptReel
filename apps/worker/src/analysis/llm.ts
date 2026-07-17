import { env } from '@scriptreel/config';
import OpenAI from 'openai';

// Single LLM entry point for the worker (analyze, knowledge expansion, media-fit verification).
// Ollama exposes an OpenAI-compatible API, so BOTH providers use the same OpenAI SDK — only the
// baseURL / apiKey / model differ. Provider is chosen by env.LLM_PROVIDER, resolved once.

export type LlmProvider = 'openai' | 'ollama';

export interface Llm {
  provider: LlmProvider;
  client: OpenAI;
  textModel: string; // analyze + knowledge expansion
  visionModel: string; // media-fit verification — MUST be able to see images
  available: boolean; // false ⇒ unconfigured; callers degrade rather than throw (invariant 7)
}

let cached: Llm | null = null;

export function getLlm(): Llm {
  if (cached) return cached;
  if (env.LLM_PROVIDER === 'ollama') {
    // apiKey is ignored by Ollama but the SDK requires a non-empty string. A local server is
    // "available" once configured; unreachability surfaces per-call and each caller degrades.
    cached = {
      provider: 'ollama',
      client: new OpenAI({ baseURL: env.OLLAMA_BASE_URL, apiKey: 'ollama', maxRetries: 2 }),
      textModel: env.OLLAMA_MODEL,
      visionModel: env.OLLAMA_VISION_MODEL,
      available: true,
    };
  } else {
    const apiKey = env.OPENAI_API_KEY;
    cached = {
      provider: 'openai',
      client: new OpenAI({ apiKey: apiKey ?? '', maxRetries: 3 }), // SDK backs off on 429/5xx
      textModel: env.OPENAI_MODEL,
      visionModel: env.OPENAI_MODEL, // gpt-4o-mini is vision-capable
      available: Boolean(apiKey),
    };
  }
  return cached;
}

// Provider-appropriate structured-output request. OpenAI supports STRICT json_schema (grammar-
// constrained); Ollama's OpenAI-compat is most reliable with json_object — the caller's zod
// validation (+ retry) then enforces the exact shape either way.
export function jsonFormat(
  name: string,
  schema: Record<string, unknown>,
): NonNullable<OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format']> {
  // OpenAI uses STRICT json_schema: the grammar guarantees the shape at negligible cost on a hosted
  // model. Ollama does NOT — llama.cpp compiles this deeply-nested schema into a GBNF grammar and
  // masks every generated token against it, which is measured at ~5x slower on the owner's box (a
  // 3-beat generation timed out at 120s under json_schema vs ~42 tok/s under generic json). That
  // made analyze of any real script overflow the request timeout and restart from zero. So Ollama
  // gets json_object (fast generic JSON) and the shape is enforced AFTER the fact: the prompt above
  // carries an explicit skeleton, most fields have zod .default()s, the cosmetic bounds COERCE
  // rather than reject (BeatSchema, invariant 7), and a single reprompt catches a genuine omission.
  // `name`/`schema` stay in the signature because the OpenAI branch still needs them.
  void name;
  return getLlm().provider === 'ollama'
    ? { type: 'json_object' }
    : { type: 'json_schema', json_schema: { name, strict: true, schema } };
}

// Extract the JSON object from a model reply. Local reasoning-capable models (qwen3, deepseek-r1)
// can wrap answers in a <think>…</think> block or stray prose even in JSON mode; strip the think
// block and slice out the first {…}. Cloud strict-schema output passes straight through.
export function extractJsonObject(content: string): string {
  const withoutThink = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const start = withoutThink.indexOf('{');
  const end = withoutThink.lastIndexOf('}');
  return start >= 0 && end > start ? withoutThink.slice(start, end + 1) : withoutThink;
}

// Test-only: drop the memoized client so a changed env is re-read.
export function _resetLlmCache(): void {
  cached = null;
}
