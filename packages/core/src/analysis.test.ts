import { describe, expect, it } from 'vitest';
import {
  type AnalysisResult,
  type Beat,
  estimateSeconds,
  mergeShortBeats,
  type ProcessedBeat,
  postProcessAnalysis,
  queryHygiene,
  reconstructionMatches,
  repairVerbatim,
  splitLongBeats,
} from './analysis';

function words(n: number): string {
  return Array.from({ length: n }, () => 'word').join(' ');
}

function beat(text: string, over: Partial<Beat> = {}): Beat {
  return {
    text,
    visualDescription: 'a calm office at dawn',
    keyPhrase: 'key phrase',
    emotion: 'neutral',
    shotType: 'wide',
    entities: { people: [], places: [], objects: [] },
    queries: {
      literal: ['office dawn', 'desk lamp'],
      conceptual: 'quiet workplace',
      mood: 'soft morning',
    },
    ...over,
  };
}

function processed(
  text: string,
  estSeconds: number,
  over: Partial<ProcessedBeat> = {},
): ProcessedBeat {
  return {
    idx: 0,
    text,
    visualDescription: 'v',
    keyPhrase: 'k',
    emotion: 'neutral',
    shotType: 'wide',
    entities: { people: [], places: [], objects: [] },
    queries: { literal: ['a', 'b'], conceptual: 'c', mood: 'm' },
    visualMoments: [],
    estSeconds,
    ...over,
  };
}

describe('reconstructionMatches', () => {
  it('ignores whitespace differences', () => {
    const script = 'Hello   world.\nThis is a test.';
    expect(
      reconstructionMatches(script, [{ text: 'Hello world.' }, { text: 'This is a test.' }]),
    ).toBe(true);
  });
  it('fails on dropped words', () => {
    expect(reconstructionMatches('one two three', [{ text: 'one three' }])).toBe(false);
  });
});

describe('repairVerbatim', () => {
  it('re-slices the script so text becomes verbatim again', () => {
    const script = 'Hello world this is a test of the system today.';
    // LLM dropped the trailing period from the boundary — not a whitespace-only diff.
    const bad = [beat('Hello world this is a'), beat('test of the system today')];
    expect(reconstructionMatches(script, bad)).toBe(false);
    const repaired = repairVerbatim(script, bad);
    expect(repaired).not.toBeNull();
    expect(reconstructionMatches(script, repaired ?? [])).toBe(true);
    expect(repaired?.[1]?.text).toContain('today.');
  });
  it('falls back to proportional re-slicing so reconstruction always succeeds', () => {
    const script = 'alpha beta gamma delta epsilon zeta';
    const out = repairVerbatim(script, [beat('zzz yyy'), beat('www vvv uuu')]);
    expect(out).not.toBeNull();
    expect(reconstructionMatches(script, out ?? [])).toBe(true);
  });
});

describe('estimateSeconds', () => {
  it('uses words/sec for English', () => {
    expect(estimateSeconds(words(27), 'en-US', 1)).toBeCloseTo(10, 0); // 27 / 2.7
  });
  it('uses chars/sec for CJK', () => {
    expect(estimateSeconds('あいうえおかきくけこ', 'ja', 1)).toBeCloseTo(10 / 5.5, 2);
  });
});

describe('mergeShortBeats', () => {
  it('merges a sub-2.5s beat into its shorter neighbor', () => {
    const beats = [
      processed(words(20), 0),
      processed(words(4), 0), // ~1.5 s → merges
      processed(words(15), 0),
    ];
    const out = mergeShortBeats(beats, 'en-US', 1);
    expect(out.length).toBe(2);
    expect(out.every((b) => b.estSeconds >= 2.5)).toBe(true);
  });

  it('keeps montage moments in text order when merging (doc 23 §7b)', () => {
    const beats = [
      processed(words(20), 0, { visualMoments: ['dawn street', 'subway station'] }),
      processed(words(4), 0, { visualMoments: ['man by gate'] }), // short trailer merges left
    ];
    const out = mergeShortBeats(beats, 'en-US', 1);
    expect(out.length).toBe(1);
    expect(out[0]?.visualMoments).toEqual(['dawn street', 'subway station', 'man by gate']);
  });
});

describe('splitLongBeats', () => {
  it('splits a >12s beat and demotes the second half literal queries', () => {
    const text = `${words(20)}. ${words(20)}`; // ~14.8 s, boundary near middle
    const out = splitLongBeats([processed(text, 0)], 'en-US', 1);
    expect(out.length).toBe(2);
    expect(out.every((b) => b.estSeconds <= 12)).toBe(true);
    expect(out[1]?.queries.literal).toEqual(['c', 'm']); // conceptual, mood
  });
});

describe('queryHygiene', () => {
  it('lowercases, strips punctuation, and demotes repeated literals', () => {
    const beats = [
      processed('a', 5, {
        queries: { literal: ['Rusty Gate!', 'Barn'], conceptual: 'farm', mood: 'dusk' },
      }),
      processed('b', 5, {
        queries: { literal: ['rusty gate', 'field'], conceptual: 'harvest', mood: 'golden' },
      }),
    ];
    const out = queryHygiene(beats);
    expect(out[0]?.queries.literal[0]).toBe('rusty gate'); // lowercased + depunctuated
    expect(out[1]?.queries.literal[0]).toBe('harvest'); // repeat of "rusty gate" → conceptual
  });
});

describe('postProcessAnalysis', () => {
  const base: Omit<AnalysisResult, 'beats'> = { language: 'en-US', musicMood: 'calm' };

  it('passes through exact reconstruction and re-indexes', () => {
    const script = `${words(10)} ${words(10)}`;
    const result: AnalysisResult = { ...base, beats: [beat(words(10)), beat(words(10))] };
    const out = postProcessAnalysis({ script, result, language: 'en-US', speed: 1 });
    expect(out.reconstruction).toBe('exact');
    expect(out.beats.map((b) => b.idx)).toEqual(out.beats.map((_, i) => i));
    expect(reconstructionMatches(script, out.beats)).toBe(true);
  });

  it('reconstructs via the proportional fallback even when the model text diverges', () => {
    const script = 'the real script words appear right here now';
    const result: AnalysisResult = { ...base, beats: [beat('totally'), beat('different text')] };
    const out = postProcessAnalysis({ script, result, language: 'en-US', speed: 1 });
    expect(reconstructionMatches(script, out.beats)).toBe(true);
  });
});
