import {
  type AnalysisResult,
  type Beat,
  PipelineError,
  type ScriptAnalyzer,
} from '@scriptreel/core';
import { describe, expect, it, vi } from 'vitest';
import { runAnalysisWithReprompt } from './run-analysis';

const SCRIPT = 'the quick brown fox jumps over the lazy dog every single morning at dawn again';

function beat(text: string): Beat {
  return {
    text,
    visualDescription: 'v',
    keyPhrase: 'k',
    emotion: 'neutral',
    shotType: 'wide',
    entities: [],
    queries: { literal: ['a', 'b'], conceptual: 'c', mood: 'm' },
    shots: [],
  };
}

function goodResult(): AnalysisResult {
  return { language: 'en-US', musicMood: 'calm', beats: [beat(SCRIPT)] };
}

function schemaError(): never {
  throw new PipelineError('E_LLM_SCHEMA', 'analyze', 'forced schema error');
}

function mockAnalyzer(impl: (call: number) => AnalysisResult): {
  analyzer: ScriptAnalyzer;
  calls: () => number;
} {
  let n = 0;
  const analyze = vi.fn(async () => {
    n += 1;
    return impl(n);
  });
  return { analyzer: { analyze }, calls: () => n };
}

const params = {
  input: { script: SCRIPT, pacing: 'normal' as const },
  script: SCRIPT,
  speed: 1,
};

describe('runAnalysisWithReprompt', () => {
  it('returns on the first valid attempt (no reprompt)', async () => {
    const { analyzer, calls } = mockAnalyzer(() => goodResult());
    const run = await runAnalysisWithReprompt(analyzer, params);
    expect(run.post.beats.length).toBeGreaterThan(0);
    expect(calls()).toBe(1);
  });

  it('reprompts exactly once, then succeeds', async () => {
    const { analyzer, calls } = mockAnalyzer((n) => (n === 1 ? schemaError() : goodResult()));
    const run = await runAnalysisWithReprompt(analyzer, params);
    expect(run.post.reconstruction).toBeDefined();
    expect(calls()).toBe(2);
  });

  it('reprompts exactly once, then fails with E_LLM_SCHEMA', async () => {
    const { analyzer, calls } = mockAnalyzer(() => schemaError());
    await expect(runAnalysisWithReprompt(analyzer, params)).rejects.toMatchObject({
      code: 'E_LLM_SCHEMA',
    });
    expect(calls()).toBe(2);
  });
});
