import { describe, expect, it } from 'vitest';
import { PipelineError } from '../errors';
import { assertRenderInvariants, type RenderProbe } from './verify';

const ok: RenderProbe = {
  durationSec: 40.767,
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48_000,
  bytes: 52_000_000,
};
const expected = { durationSec: 40.767, width: 1920, height: 1080 };

describe('assertRenderInvariants', () => {
  it('passes a well-formed render', () => {
    expect(() => assertRenderInvariants(ok, expected)).not.toThrow();
  });

  it('fires E_COMPOSE_VERIFY when A/V drift exceeds 100ms (the deliberately-broken case)', () => {
    try {
      assertRenderInvariants({ ...ok, durationSec: 41.0 }, expected); // +233ms drift
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as PipelineError).code).toBe('E_COMPOSE_VERIFY');
    }
  });

  it('fires on wrong geometry, fps, sample rate, and empty output', () => {
    expect(() => assertRenderInvariants({ ...ok, width: 1280 }, expected)).toThrow(PipelineError);
    expect(() => assertRenderInvariants({ ...ok, fps: 25 }, expected)).toThrow(PipelineError);
    expect(() => assertRenderInvariants({ ...ok, sampleRate: 44_100 }, expected)).toThrow(
      PipelineError,
    );
    expect(() => assertRenderInvariants({ ...ok, bytes: 0 }, expected)).toThrow(PipelineError);
  });
});
