import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashObject, sha1Hex, stableStringify } from './hash';

describe('sha1Hex', () => {
  it('matches known SHA-1 vectors', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    );
  });

  it('is byte-identical to node:crypto for varied inputs (incl. multibyte + long)', () => {
    const cases = [
      'a',
      'hello world',
      'café — résumé — 日本語 — 🎬',
      JSON.stringify({ b: 2, a: [1, 2, 3], nested: { z: true } }),
      'x'.repeat(1000),
      '9:16|video|portrait|city skyline',
    ];
    for (const c of cases) {
      const node = createHash('sha1').update(c).digest('hex');
      expect(sha1Hex(c)).toBe(node);
    }
  });
});

describe('hashObject', () => {
  it('is order-independent over object keys', () => {
    expect(hashObject({ a: 1, b: 2 })).toBe(hashObject({ b: 2, a: 1 }));
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
