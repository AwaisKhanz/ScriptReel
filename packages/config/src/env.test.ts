import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

describe('loadEnv', () => {
  it('applies defaults when infra vars are absent', () => {
    const parsed = loadEnv({});
    expect(parsed.DATA_DIR).toBe('./data');
    expect(parsed.SIDECAR_URL).toBe('http://127.0.0.1:8484');
    expect(parsed.LLM_PROVIDER).toBe('openai');
    expect(parsed.OPENAI_MODEL).toBe('gpt-4o-mini');
  });

  it('leaves the OpenAI key optional (stock-provider keys live in the DB, not env)', () => {
    const parsed = loadEnv({});
    expect(parsed.OPENAI_API_KEY).toBeUndefined();
  });

  it('accepts openai + ollama LLM providers, rejects unknown ones', () => {
    expect(loadEnv({ LLM_PROVIDER: 'ollama' }).LLM_PROVIDER).toBe('ollama');
    expect(loadEnv({ LLM_PROVIDER: 'openai' }).LLM_PROVIDER).toBe('openai');
    expect(() => loadEnv({ LLM_PROVIDER: 'gemini' })).toThrow(/Invalid environment/);
  });
});
