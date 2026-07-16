import {
  type AnalysisResult,
  type AnalyzeOptions,
  type Beat,
  PipelineError,
  type ScriptAnalyzer,
} from '@scriptreel/core';
import { describe, expect, it, vi } from 'vitest';
import { runAnalysisWithReprompt, VERBATIM_RETRY_HINT } from './run-analysis';

const SCRIPT = 'the quick brown fox jumps over the lazy dog every single morning at dawn again';

function beat(text: string, visualDescription = 'v'): Beat {
  return {
    text,
    visualDescription,
    keyPhrase: 'k',
    emotion: 'neutral',
    shotType: 'wide',
    era: 'timeless',
    entities: [],
    queries: { literal: ['a', 'b'], conceptual: 'c', mood: 'm' },
    shots: [],
  };
}

function goodResult(): AnalysisResult {
  return { language: 'en-US', musicMood: 'calm', beats: [beat(SCRIPT)] };
}

// The model summarized instead of segmenting: the words are gone, so anchor repair cannot
// match and only the proportional re-slice could rebuild the script.
function summarizedResult(): AnalysisResult {
  return {
    language: 'en-US',
    musicMood: 'calm',
    beats: [
      beat('a fox jumps.', 'a fox mid-leap'),
      beat('it was morning.', 'sunrise over a field'),
    ],
  };
}

function schemaError(): never {
  throw new PipelineError('E_LLM_SCHEMA', 'analyze', 'forced schema error');
}

function mockAnalyzer(impl: (call: number) => AnalysisResult): {
  analyzer: ScriptAnalyzer;
  calls: () => number;
  hints: () => (string | undefined)[];
} {
  let n = 0;
  const seen: (string | undefined)[] = [];
  const analyze = vi.fn(async (_input, opts?: AnalyzeOptions) => {
    n += 1;
    seen.push(opts?.retryHint);
    return impl(n);
  });
  return { analyzer: { analyze }, calls: () => n, hints: () => seen };
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

  it('reprompts when anchors fail on a summarized script, not only on zod errors', async () => {
    const { analyzer, calls, hints } = mockAnalyzer((n) =>
      n === 1 ? summarizedResult() : goodResult(),
    );
    const run = await runAnalysisWithReprompt(analyzer, params);
    expect(calls()).toBe(2);
    expect(hints()[1]).toBe(VERBATIM_RETRY_HINT);
    expect(run.post.reconstruction).toBe('exact');
  });

  it('ships the proportional re-slice only after the reprompt also misses, and labels it', async () => {
    // Invariant 7: degrade, never die — but the label is what makes the degrade visible.
    const { analyzer, calls } = mockAnalyzer(() => summarizedResult());
    const run = await runAnalysisWithReprompt(analyzer, params);
    expect(calls()).toBe(2);
    expect(run.post.reconstruction).toBe('proportional');
  });

  it('reprompts exactly once, then fails with E_LLM_SCHEMA', async () => {
    const { analyzer, calls } = mockAnalyzer(() => schemaError());
    await expect(runAnalysisWithReprompt(analyzer, params)).rejects.toMatchObject({
      code: 'E_LLM_SCHEMA',
    });
    expect(calls()).toBe(2);
  });
});
