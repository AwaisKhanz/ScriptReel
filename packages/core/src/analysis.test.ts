import { describe, expect, it } from 'vitest';
import {
  type AnalysisResult,
  type Beat,
  type Entity,
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
  it('splits a >12s beat and demotes both halves when neither names a shot', () => {
    const text = `${words(20)}. ${words(20)}`; // ~14.8 s, boundary near middle
    const out = splitLongBeats([processed(text, 0)], 'en-US', 1);
    expect(out.length).toBe(2);
    expect(out.every((b) => b.estSeconds <= 12)).toBe(true);
    // The parent's literal queries described the whole sentence, so neither half may claim
    // them; with no shots to derive from, both fall back to the beat-level tiers.
    expect(out[0]?.queries.literal).toEqual(['c', 'm']);
    expect(out[1]?.queries.literal).toEqual(['c', 'm']);
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

  // Regression, from a real gpt-4o run on the owner's Voyager script. The parent beat described
  // the whole sentence; both halves inherited that description and its literal queries, so the
  // half narrating "NASA commanded Voyager to turn around" was scored against — and searching
  // for — "earth pale blue dot", which belongs to the other half.
  const paleBlueDot = (): ProcessedBeat =>
    processed(
      'In 1990, before leaving the planetary neighborhood forever, NASA commanded Voyager to turn around one last time. From nearly six billion kilometers away, it captured a tiny image of Earth—a barely visible dot suspended in a beam of sunlight.',
      0,
      {
        visualDescription: 'Earth as a pale blue dot, vast space',
        queries: {
          literal: ['earth pale blue dot', 'tiny earth space'],
          conceptual: 'our place in universe',
          mood: 'inspiring',
        },
        shots: [{ phrase: 'earth pale blue dot', entity: 'Earth', want: 'scene', weight: 3 }],
        visualMoments: ['earth pale blue dot'],
      },
    );

  it("a half never carries the other half's visualDescription or literal queries", () => {
    const out = splitLongBeats([paleBlueDot()], 'en-US', 1);
    expect(out).toHaveLength(2);
    const [head, tail] = out;
    if (!head || !tail) throw new Error('expected two halves');

    // The tail names Earth, so it keeps the shot and its description follows from it.
    expect(tail.shots.map((s) => s.entity)).toEqual(['Earth']);
    expect(tail.visualDescription).toBe('earth pale blue dot');

    // The head names no shot, so it must NOT claim the pale-blue-dot imagery.
    expect(head.shots).toEqual([]);
    expect(head.visualDescription).not.toBe('Earth as a pale blue dot, vast space');
    expect(head.queries.literal).not.toContain('earth pale blue dot');

    // Two beats pointed at one image also fight over it (REUSE/DUP penalties), so the anchors
    // must differ — not merely be non-empty.
    expect(head.visualDescription).not.toBe(tail.visualDescription);
  });

  it('entities follow their shots — a half is not "about" what it never mentions', () => {
    const parent = paleBlueDot();
    parent.entities = [
      {
        surface: 'Earth',
        canonical: 'Earth',
        category: 'planet',
        instanceOf: 'planet',
        disambiguation: '',
        searchTerms: [],
        visualizable: true,
      },
    ];
    const out = splitLongBeats([parent], 'en-US', 1);
    const [head, tail] = out;
    // Only the tail says "Earth", so only the tail carries it — otherwise the head's topic
    // routes to `space` on a subject it never names.
    expect(tail?.entities.map((e) => e.canonical)).toEqual(['Earth']);
    expect(head?.entities).toEqual([]);
  });
});

describe('queryHygiene — tier-1 slots must stay distinct', () => {
  // Regression, from the same run: when BOTH literals repeated the previous beat, each was
  // rewritten to `conceptual` independently and the beat ended up firing one query twice —
  // observed as ["our place in universe", "our place in universe"]. Half the pool, silently.
  it('never emits the same literal query twice in one beat', () => {
    const first = processed('a', 5, {
      queries: {
        literal: ['earth pale blue dot', 'tiny earth space'],
        conceptual: 'c1',
        mood: 'm1',
      },
    });
    const second = processed('b', 5, {
      queries: {
        literal: ['earth pale blue dot', 'tiny earth space'], // both repeat beat 1
        conceptual: 'our place in universe',
        mood: 'inspiring',
      },
    });
    const out = queryHygiene([first, second]);
    const literal = out[1]?.queries.literal ?? [];
    expect(literal).toHaveLength(2);
    expect(new Set(literal).size).toBe(2);
  });

  it('still prefers a fresh query over one the previous beat already used', () => {
    const first = processed('a', 5, {
      queries: { literal: ['shared query', 'unique one'], conceptual: 'c1', mood: 'm1' },
    });
    const second = processed('b', 5, {
      queries: { literal: ['shared query', 'own angle'], conceptual: 'c2', mood: 'm2' },
    });
    const out = queryHygiene([first, second]);
    // 'shared query' was used by beat 1 → demoted; 'own angle' is fresh → kept as-is.
    expect(out[1]?.queries.literal).toEqual(['c2', 'own angle']);
  });
});

describe('every visualizable entity gets a shot', () => {
  const entity = (canonical: string, over: Partial<Entity> = {}): Entity => ({
    surface: canonical,
    canonical,
    category: 'object',
    instanceOf: 'thing',
    disambiguation: '',
    searchTerms: [`${canonical} close up`],
    visualizable: true,
    ...over,
  });

  // Regression, from a live gpt-4o run on the beet-juice script: the model named kidney stones,
  // diabetes, kidney disease and blood pressure, then designed ONE "doctor discussing health
  // concerns" shot. Because search walks shots and resolves shot.entity, all four entities were
  // never searched — the beat cost an LLM call and rendered generic stock anyway.
  it('derives a shot for an entity the model left undepicted', () => {
    const script = 'These nutrients concern people with kidney stones, diabetes, or hypertension.';
    const out = postProcessAnalysis({
      script,
      result: {
        language: 'en-US',
        musicMood: 'calm',
        beats: [
          beat(script, {
            entities: [
              entity('kidney stone', { category: 'anatomy' }),
              entity('diabetes', { category: 'concept' }),
              entity('hypertension', { category: 'concept' }),
            ],
            shots: [
              {
                phrase: 'doctor discussing health concerns',
                entity: '',
                want: 'generic',
                weight: 1,
              },
            ],
          }),
        ],
      },
      language: 'en-US',
      speed: 1,
    });
    const depicted = out.beats[0]?.shots.map((s) => s.entity) ?? [];
    expect(depicted).toContain('kidney stone');
    expect(depicted).toContain('diabetes');
    expect(depicted).toContain('hypertension');
    // The model's own summary shot is kept — it is context, just not a substitute.
    expect(out.beats[0]?.shots[0]?.phrase).toBe('doctor discussing health concerns');
  });

  it('uses the entity searchTerms and its category default want', () => {
    const script = 'Carl Sagan called it the pale blue dot.';
    const out = postProcessAnalysis({
      script,
      result: {
        language: 'en-US',
        musicMood: 'calm',
        beats: [
          beat(script, {
            entities: [
              entity('Carl Sagan', { category: 'person', searchTerms: ['carl sagan portrait'] }),
            ],
          }),
        ],
      },
      language: 'en-US',
      speed: 1,
    });
    expect(out.beats[0]?.shots[0]).toMatchObject({
      phrase: 'carl sagan portrait',
      entity: 'Carl Sagan',
      want: 'portrait', // CATEGORY_DEFAULT_WANT.person
    });
  });

  it('leaves non-visualizable entities alone — they belong on generic b-roll', () => {
    const script = 'Freedom is what they were fighting for.';
    const out = postProcessAnalysis({
      script,
      result: {
        language: 'en-US',
        musicMood: 'calm',
        beats: [
          beat(script, {
            entities: [entity('freedom', { category: 'concept', visualizable: false })],
          }),
        ],
      },
      language: 'en-US',
      speed: 1,
    });
    expect(out.beats[0]?.shots).toEqual([]);
  });
});

describe('the shot plan is never truncated to a fixed number', () => {
  // The owner's case: "the apple, mango and yogurt are powerful for old people for their liver"
  // is five things on screen. deriveMoments used to .slice(0, 4), dropping the liver AFTER the
  // analyzer had correctly planned it — and visual_moments, not shots, is what score reads.
  it('carries every planned shot through to visualMoments', () => {
    const shots: Shot[] = ['apple', 'mango', 'yogurt', 'old people', 'liver'].map((p) => ({
      phrase: `${p} close up`,
      entity: p,
      want: 'scene',
      weight: 1,
    }));
    const script = 'The apple, mango and yogurt are powerful for old people for their liver.';
    const out = postProcessAnalysis({
      script,
      result: {
        language: 'en-US',
        musicMood: 'calm',
        beats: [beat(script, { shots, visualDescription: 'five foods' })],
      },
      language: 'en-US',
      speed: 1,
    });
    expect(out.beats[0]?.visualMoments).toHaveLength(5);
    expect(out.beats[0]?.visualMoments).toContain('liver close up');
  });
});
