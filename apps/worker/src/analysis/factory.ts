import type { ScriptAnalyzer } from '@scriptreel/core';
import type { Logger } from 'pino';
import { OpenAiAnalyzer } from './openai-analyzer';

// The analyzer speaks the OpenAI chat API, which serves BOTH providers — OpenAI cloud and a local
// Ollama server — so one class covers both. The active provider/model is resolved in llm.ts from
// env.LLM_PROVIDER (owner re-enabled local LLMs 2026-07-13).
export function getAnalyzer(log: Logger): ScriptAnalyzer {
  return new OpenAiAnalyzer(log);
}
