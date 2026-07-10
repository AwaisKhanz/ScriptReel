import { describe, expect, it } from 'vitest';
import { TEXTCARD_THEMES, themeForEmotion } from './emotion';
import { broadenQuery } from './providers';

describe('themeForEmotion', () => {
  it('maps every analyzer emotion to a real theme', () => {
    const emotions = [
      'neutral',
      'uplifting',
      'serious',
      'tense',
      'sad',
      'exciting',
      'calm',
      'inspiring',
    ];
    for (const e of emotions) {
      expect(TEXTCARD_THEMES).toContain(themeForEmotion(e));
    }
    expect(themeForEmotion('serious')).toBe('corporate');
    expect(themeForEmotion('inspiring')).toBe('uplifting');
  });
  it('falls back to neutral for unknown emotions', () => {
    expect(themeForEmotion('bewildered')).toBe('neutral');
  });
});

describe('broadenQuery', () => {
  it('drops trailing atmosphere then reduces to the head noun phrase', () => {
    expect(broadenQuery('rusty farm gate dusk')).toEqual(['farm gate', 'gate']);
  });
  it('never returns the original query and dedupes', () => {
    expect(broadenQuery('empty street morning')).toEqual(['street']);
    expect(broadenQuery('gate')).toEqual([]); // nothing broader
  });
  it('respects the max count', () => {
    expect(broadenQuery('big red vintage sports car', 1)).toHaveLength(1);
  });
});
