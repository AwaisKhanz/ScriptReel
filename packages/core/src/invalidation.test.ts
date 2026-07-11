import { describe, expect, it } from 'vitest';
import { invalidatedStages, narrowestMode } from './invalidation';
import type { ProjectSettings } from './settings';

const CURRENT = {
  voice: 'af_heart',
  speed: 1,
  pauseMs: 150,
  aspect: '16:9',
  quality: 'final',
  mediaPreference: 'mixed',
  subtitlePreset: 'clean',
  subtitlePosition: 'bottom',
  musicMood: 'auto',
  musicLevelDb: -16,
  transitionStyle: 'smart',
} as Partial<ProjectSettings> as ProjectSettings;

describe('invalidatedStages (doc 06 consequences)', () => {
  it('subtitle / music / quality change → compose only', () => {
    expect(invalidatedStages({ subtitlePreset: 'pop' }, CURRENT)).toEqual(['compose']);
    expect(invalidatedStages({ musicMood: 'calm' }, CURRENT)).toEqual(['compose']);
    expect(invalidatedStages({ musicLevelDb: -12 }, CURRENT)).toEqual(['compose']);
    expect(invalidatedStages({ quality: 'draft' }, CURRENT)).toEqual(['compose']);
  });

  it('aspect change → search, score, fetch, compose (tts/align survive)', () => {
    expect(invalidatedStages({ aspect: '9:16' }, CURRENT)).toEqual([
      'search',
      'score',
      'fetch',
      'compose',
    ]);
  });

  it('voice / speed change → tts, align, compose (visual selections survive)', () => {
    expect(invalidatedStages({ voice: 'am_adam' }, CURRENT)).toEqual(['tts', 'align', 'compose']);
    expect(invalidatedStages({ speed: 1.1 }, CURRENT)).toEqual(['tts', 'align', 'compose']);
  });

  it('mediaPreference change → search, score, fetch, compose', () => {
    expect(invalidatedStages({ mediaPreference: 'videos' }, CURRENT)).toEqual([
      'search',
      'score',
      'fetch',
      'compose',
    ]);
  });

  it('no-op patch (same value / undefined) invalidates nothing', () => {
    expect(invalidatedStages({ aspect: '16:9' }, CURRENT)).toEqual([]);
    expect(invalidatedStages({ subtitlePreset: undefined }, CURRENT)).toEqual([]);
    expect(invalidatedStages({}, CURRENT)).toEqual([]);
  });

  it('merges multiple changes and keeps pipeline order', () => {
    expect(invalidatedStages({ aspect: '1:1', musicMood: 'tense' }, CURRENT)).toEqual([
      'search',
      'score',
      'fetch',
      'compose',
    ]);
  });

  it('narrowestMode: aspect → full, compose-only change → composeOnly', () => {
    expect(narrowestMode(invalidatedStages({ aspect: '9:16' }, CURRENT))).toBe('full');
    expect(narrowestMode(invalidatedStages({ musicMood: 'calm' }, CURRENT))).toBe('composeOnly');
    expect(narrowestMode([])).toBe('composeOnly');
  });
});
