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
  type Shot,
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
    era: 'timeless',
    entities: [],
    queries: {
      literal: ['office dawn', 'desk lamp'],
      conceptual: 'quiet workplace',
      mood: 'soft morning',
    },
    shots: [],
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
    era: 'timeless',
    entities: [],
    queries: { literal: ['a', 'b'], conceptual: 'c', mood: 'm' },
    shots: [],
    visualMoments: [],
    estSeconds,
    ...over,
  };
}

function shot(phrase: string): Shot {
  return { phrase, entity: '', want: 'generic', weight: 1 };
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
    expect(repaired?.method).toBe('anchors');
    expect(reconstructionMatches(script, repaired?.beats ?? [])).toBe(true);
    expect(repaired?.beats[1]?.text).toContain('today.');
  });
  it('reports the proportional fallback as such — its boundaries are arithmetic, not semantic', () => {
    const script = 'alpha beta gamma delta epsilon zeta';
    const out = repairVerbatim(script, [beat('zzz yyy'), beat('www vvv uuu')]);
    expect(out?.method).toBe('proportional');
    expect(reconstructionMatches(script, out?.beats ?? [])).toBe(true);
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

  it('keeps the shot plan in text order when merging (doc 24 §3)', () => {
    const beats = [
      processed(words(20), 0, { shots: [shot('dawn street'), shot('subway station')] }),
      processed(words(4), 0, { shots: [shot('man by gate')] }), // short trailer merges left
    ];
    const out = mergeShortBeats(beats, 'en-US', 1);
    expect(out.length).toBe(1);
    expect(out[0]?.shots.map((s) => s.phrase)).toEqual([
      'dawn street',
      'subway station',
      'man by gate',
    ]);
    // visualMoments is the derived back-compat projection of the shot plan
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

  // A summarized beat set: the words are gone, so no anchor matches and only the proportional
  // re-slice can rebuild the script — by stapling each beat's visuals onto someone else's text.
  const summarized = (): { script: string; result: AnalysisResult } => ({
    script:
      'Grapes are tiny balloons of sugar. Bananas with brown spots are worse for you. Berries are the safest fruit of all.',
    result: {
      ...base,
      beats: [
        beat('Grapes are sugar.', { visualDescription: 'close-up of grapes' }),
        beat('Bananas are worse.', { visualDescription: 'close-up of ripe bananas' }),
        beat('In conclusion, eat berries.', { visualDescription: 'close-up of berries' }),
      ],
    },
  });

  it('refuses to staple a beat’s visuals onto a proportionally re-sliced text', () => {
    const { script, result } = summarized();
    // Contiguous slices always reconstruct, so nothing downstream can catch this: the post-pass
    // must reject it here, which is what makes the verbatim reprompt reachable at all.
    expect(() => postProcessAnalysis({ script, result, language: 'en-US', speed: 1 })).toThrow(
      expect.objectContaining({ code: 'E_LLM_SCHEMA' }),
    );
  });

  it('records the repair method so proportional output is never mistaken for exact boundaries', () => {
    const { script, result } = summarized();
    const out = postProcessAnalysis({
      script,
      result,
      language: 'en-US',
      speed: 1,
      allowProportional: true,
    });
    expect(out.reconstruction).toBe('proportional');
    expect(reconstructionMatches(script, out.beats)).toBe(true);
  });
});

// A long beat's shot plan must survive the split. Regression for a real gpt-4o run: it designed 3
// shots for the five-fruit sentence, splitLongBeats cut that sentence into 4 beats, and every child
// shipped `shots: []` with the parent's single visualDescription — so four consecutive beats fetched
// one asset where the model had planned a montage.
describe('splitLongBeats — shot inheritance', () => {
  const fiveFruits =
    'There are five fruits you need to rethink: grapes are tiny balloons of concentrated sugar with very little fiber; watermelon is a high Glycemic Index fruit that acts as a naked carbohydrate; ripe bananas with brown spots have converted their starch into sugar; dried fruits like raisins and dates are concentrated sugar bombs; and mangoes contain up to 45 grams of sugar per fruit with very little fiber to balance it out.';

  const beat = () => ({
    text: fiveFruits,
    visualDescription: 'variety of fruits on table',
    keyPhrase: 'Rethink these five fruits',
    emotion: 'serious' as const,
    shotType: 'wide' as const,
    era: 'modern' as const,
    entities: [],
    queries: {
      literal: ['high sugar fruits', 'fruit bowl'],
      conceptual: 'high sugar fruits',
      mood: 'cautionary',
    },
    shots: [
      { phrase: 'grapes close up', entity: 'grapes', want: 'scene' as const, weight: 1 },
      {
        phrase: 'ripe bananas with brown spots',
        entity: 'bananas',
        want: 'scene' as const,
        weight: 1,
      },
      { phrase: 'mango on counter', entity: 'mango', want: 'scene' as const, weight: 1 },
    ],
    visualMoments: ['grapes close up', 'ripe bananas with brown spots', 'mango on counter'],
    estSeconds: 0,
  });

  it('gives each half the shots its own text names, instead of blanking both', () => {
    const out = splitLongBeats([beat()], 'en-US', 1);
    expect(out.length).toBeGreaterThan(1);

    // Every shot must land on a beat whose text actually mentions it — that is the whole contract.
    for (const b of out) {
      for (const s of b.shots) {
        expect(b.text.toLowerCase()).toContain(s.entity.toLowerCase());
      }
    }
    // And the plan must not evaporate: the model's shots survive the split somewhere.
    const kept = out.flatMap((b) => b.shots.map((s) => s.entity));
    expect(kept).toContain('grapes');
    expect(kept).toContain('mango');
    // visualMoments are derived from shots, so they must travel with them (montage planning reads these).
    const withShots = out.filter((b) => b.shots.length > 0);
    expect(withShots.length).toBeGreaterThan(0);
    for (const b of withShots) expect(b.visualMoments).toEqual(b.shots.map((s) => s.phrase));
  });
});
