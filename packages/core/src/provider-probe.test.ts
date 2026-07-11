import { describe, expect, it } from 'vitest';
import {
  interpretOpenverseRateLimit,
  PROVIDER_PROBE,
  parseRateLimitHeaders,
} from './provider-probe';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');

function headerGet(map: Record<string, string>): (name: string) => string | null {
  return (name) => map[name.toLowerCase()] ?? null;
}

describe('parseRateLimitHeaders', () => {
  it('reads the x-ratelimit trio; epoch reset → absolute ISO (Pexels)', () => {
    const reset = Math.floor(NOW / 1000) + 3600;
    const rl = parseRateLimitHeaders(
      headerGet({
        'x-ratelimit-limit': '20000',
        'x-ratelimit-remaining': '19998',
        'x-ratelimit-reset': String(reset),
      }),
      'epoch',
      NOW,
    );
    expect(rl.limit).toBe(20000);
    expect(rl.remaining).toBe(19998);
    expect(rl.resetAt).toBe('2026-07-11T13:00:00.000Z');
  });

  it('seconds reset → now + seconds (Pixabay)', () => {
    const rl = parseRateLimitHeaders(
      headerGet({
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '97',
        'x-ratelimit-reset': '30',
      }),
      'seconds',
      NOW,
    );
    expect(rl.limit).toBe(100);
    expect(rl.resetAt).toBe('2026-07-11T12:00:30.000Z');
  });

  it('missing headers → nulls, never throws', () => {
    const rl = parseRateLimitHeaders(headerGet({}), 'epoch', NOW);
    expect(rl).toEqual({ limit: null, remaining: null, resetAt: null });
  });
});

describe('interpretOpenverseRateLimit', () => {
  it('maps the model to a daily limit and derives remaining', () => {
    const r = interpretOpenverseRateLimit({ rate_limit_model: 'standard', requests_today: 40 });
    expect(r.limit).toBe(10_000);
    expect(r.remaining).toBe(9_960);
    expect(r.detail).toContain('standard');
  });

  it('unknown model → limit null but still valid/usable', () => {
    const r = interpretOpenverseRateLimit({ rate_limit_model: 'mystery', requests_today: 3 });
    expect(r.limit).toBeNull();
    expect(r.remaining).toBeNull();
  });
});

describe('PROVIDER_PROBE coverage', () => {
  it('declares a spec for every provider', () => {
    for (const p of ['pexels', 'pixabay', 'openverse', 'nasa', 'wikimedia'] as const) {
      expect(PROVIDER_PROBE[p]?.url).toMatch(/^https:\/\//);
    }
    expect(PROVIDER_PROBE.nasa.limitSource).toBe('none');
    expect(PROVIDER_PROBE.pexels.resetKind).toBe('epoch');
    expect(PROVIDER_PROBE.pixabay.resetKind).toBe('seconds');
  });
});
