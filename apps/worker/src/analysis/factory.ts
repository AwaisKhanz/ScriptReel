import { env } from '@scriptreel/config';
import { PipelineError, type ScriptAnalyzer } from '@scriptreel/core';
import type { Logger } from 'pino';
import { OpenAiAnalyzer } from './openai-analyzer';

// OpenAI is the only provider (owner directive 2026-07-10; no local LLM, no Gemini).
export function getAnalyzer(log: Logger): ScriptAnalyzer {
  const provider = env.LLM_PROVIDER;
  if (provider !== 'openai') {
    throw new PipelineError('E_ENV', 'analyze', `unsupported LLM_PROVIDER: ${provider}`);
  }
  return new OpenAiAnalyzer(log);
}
