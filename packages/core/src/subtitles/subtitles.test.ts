import { describe, expect, it } from 'vitest';
import {
  type AlignBeat,
  alignWords,
  proportionalAlign,
  tokenMatchRate,
  type WhisperWord,
} from './align';
import { buildAss } from './buildAss';

const beats: AlignBeat[] = [
  { idx: 0, text: 'the quick brown fox', startSec: 0, durationSec: 2, language: 'en-US' },
  { idx: 1, text: 'jumps over the dog', startSec: 2, durationSec: 2, language: 'en-US' },
];

const whisper: WhisperWord[] = [
  { word: 'The', start: 0.0, end: 0.4 },
  { word: 'quick', start: 0.4, end: 0.8 },
  { word: 'brown', start: 0.8, end: 1.3 },
  { word: 'fox.', start: 1.3, end: 1.9 },
  { word: 'Jumps', start: 2.0, end: 2.4 },
  { word: 'over', start: 2.4, end: 2.7 },
  { word: 'the', start: 2.7, end: 2.9 },
  { word: 'dog', start: 2.9, end: 3.8 },
];

describe('alignWords', () => {
  it('maps whisper timings onto script tokens, monotonic + beat-bounded', () => {
    const words = alignWords(beats, whisper);
    expect(words).toHaveLength(8);
    expect(words[0]?.word).toBe('the');
    expect(words[0]?.start).toBe(0);
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i]?.start ?? 0).toBeGreaterThanOrEqual((words[i - 1]?.end ?? 0) - 1e-9);
    }
    for (const w of words) {
      const lo = w.beatIdx === 0 ? 0 : 2;
      const hi = w.beatIdx === 0 ? 2 : 4;
      expect(w.start).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(w.end).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it('proportional fallback distributes each beat span by char weight', () => {
    const words = proportionalAlign(beats);
    expect(words).toHaveLength(8);
    expect(words[0]?.start).toBe(0);
    expect(words.at(-1)?.end ?? 0).toBeCloseTo(4, 1);
  });

  it('reports a high token match rate against matching whisper', () => {
    expect(tokenMatchRate(beats, whisper)).toBeGreaterThanOrEqual(0.95);
  });
});

describe('buildAss', () => {
  const words = alignWords(beats, whisper);

  it('clean renders caption Dialogue events at 1920×1080', () => {
    const ass = buildAss({ words, preset: 'clean', aspect: '16:9', language: 'en-US' });
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toContain('Style: Default,Inter,54');
    expect(ass).toMatch(/Dialogue: 0,/);
  });

  it('pop emits karaoke \\k tags', () => {
    const ass = buildAss({ words, preset: 'pop', aspect: '9:16', language: 'en-US' });
    expect(ass).toMatch(/\{\\k\d+\}/);
  });

  it('hi selects Noto Sans Devanagari', () => {
    const ass = buildAss({ words, preset: 'clean', aspect: '16:9', language: 'hi' });
    expect(ass).toContain('Noto Sans Devanagari');
  });
});
