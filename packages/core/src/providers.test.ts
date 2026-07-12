import { describe, expect, it } from 'vitest';
import { PIXABAY_MINUTE_BUDGET } from './constants';
import {
  matchesOrientation,
  normalizeSearchQuery,
  orientationForAspect,
  passesHygiene,
  planTier1Requests,
  QUOTA_BUDGETS,
  type RawCandidate,
  searchCacheKey,
  targetHeightForAspect,
  truncateWindow,
} from './providers';

function candidate(overrides: Partial<RawCandidate>): RawCandidate {
  return {
    provider: 'pexels',
    providerId: '1',
    kind: 'video',
    width: 1920,
    height: 1080,
    duration: 10,
    thumbUrl: 'https://x/t.jpg',
    downloadUrl: 'https://x/v.mp4',
    pageUrl: 'https://x/p',
    author: 'A',
    license: 'L',
    ...overrides,
  };
}

describe('normalizeSearchQuery', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeSearchQuery('  City   SKYLINE  ')).toBe('city skyline');
    expect(normalizeSearchQuery('a\tb\nc')).toBe('a b c');
  });
});

describe('searchCacheKey', () => {
  it('is stable and normalization-insensitive', () => {
    const a = searchCacheKey('pexels', 'video', 'landscape', 'City  Skyline ');
    const b = searchCacheKey('pexels', 'video', 'landscape', 'city skyline');
    expect(a).toBe(b);
  });
  it('varies by provider, kind, orientation', () => {
    const base = searchCacheKey('pexels', 'video', 'landscape', 'ocean');
    expect(searchCacheKey('pixabay', 'video', 'landscape', 'ocean')).not.toBe(base);
    expect(searchCacheKey('pexels', 'image', 'landscape', 'ocean')).not.toBe(base);
    expect(searchCacheKey('pexels', 'video', 'portrait', 'ocean')).not.toBe(base);
  });
});

describe('planTier1Requests', () => {
  const literal = ['sunrise beach', 'calm waves'];

  it('videos: Pexels video + Pixabay video only', () => {
    expect(planTier1Requests(literal, 'videos')).toEqual([
      { provider: 'pexels', kind: 'video', query: 'sunrise beach' },
      { provider: 'pixabay', kind: 'video', query: 'calm waves' },
    ]);
  });

  it('mixed: adds Pixabay + Openverse images (doc 23)', () => {
    const plan = planTier1Requests(literal, 'mixed');
    expect(plan.map((r) => `${r.provider}:${r.kind}`)).toEqual([
      'pexels:video',
      'pixabay:video',
      'pixabay:image',
      'openverse:image',
    ]);
    expect(plan[3]).toEqual({ provider: 'openverse', kind: 'image', query: 'sunrise beach' });
  });

  it('photos: adds Pixabay + Openverse images + Pexels photo', () => {
    const plan = planTier1Requests(literal, 'photos');
    expect(plan.map((r) => `${r.provider}:${r.kind}`)).toEqual([
      'pexels:video',
      'pixabay:video',
      'pixabay:image',
      'openverse:image',
      'pexels:image',
    ]);
  });

  it('routes a matching domain to its archive provider (NASA on space)', () => {
    const space = planTier1Requests(literal, 'mixed', 'space').map(
      (r) => `${r.provider}:${r.kind}`,
    );
    expect(space).toContain('nasa:image');
    // generic beats never fire the archive
    const generic = planTier1Requests(literal, 'mixed', 'generic').map((r) => r.provider);
    expect(generic).not.toContain('nasa');
    // videos-only never fires image archives either
    expect(planTier1Requests(literal, 'videos', 'space').map((r) => r.provider)).not.toContain(
      'nasa',
    );
  });

  it('routes named-subject domains to Wikimedia, but not generic/urban (doc 23)', () => {
    const history = planTier1Requests(literal, 'mixed', 'history').map((r) => r.provider);
    expect(history).toContain('wikimedia');
    const people = planTier1Requests(literal, 'mixed', 'people').map((r) => r.provider);
    expect(people).toContain('wikimedia');
    // stock-covered domains keep Wikimedia out of the fan-out
    expect(planTier1Requests(literal, 'mixed', 'urban').map((r) => r.provider)).not.toContain(
      'wikimedia',
    );
    expect(planTier1Requests(literal, 'mixed', 'generic').map((r) => r.provider)).not.toContain(
      'wikimedia',
    );
  });

  it('routes art/history to the Met archive, but not unrelated domains (doc 25)', () => {
    expect(planTier1Requests(['x'], 'mixed', 'art').map((r) => r.provider)).toContain('met');
    expect(planTier1Requests(['x'], 'mixed', 'urban').map((r) => r.provider)).not.toContain('met');
  });

  it('routes covered domains to the Internet Archive video archive on mixed, not photos (doc 25)', () => {
    // Video archive: fires for a covered domain when videos are wanted (mixed).
    expect(planTier1Requests(['x'], 'mixed', 'history').map((r) => r.provider)).toContain(
      'internet-archive',
    );
    // Photos-only never fires a video archive.
    expect(planTier1Requests(['x'], 'photos', 'history').map((r) => r.provider)).not.toContain(
      'internet-archive',
    );
    // Domain miss: never fires on an uncovered domain.
    expect(planTier1Requests(['x'], 'mixed', 'urban').map((r) => r.provider)).not.toContain(
      'internet-archive',
    );
  });

  it('routes the doc-25 group-B image archives by domain (doc 25)', () => {
    expect(planTier1Requests(['x'], 'mixed', 'nature').map((r) => r.provider)).toContain(
      'inaturalist',
    );
    expect(planTier1Requests(['x'], 'mixed', 'science').map((r) => r.provider)).toContain('usgs');
    const history = planTier1Requests(['x'], 'mixed', 'history').map((r) => r.provider);
    expect(history).toContain('library-of-congress');
    expect(history).toContain('europeana');
    expect(history).toContain('smithsonian');
    expect(planTier1Requests(['x'], 'mixed', 'people').map((r) => r.provider)).toContain('flickr');
    // Negative: europeana covers only history/art, never urban.
    expect(planTier1Requests(['x'], 'mixed', 'urban').map((r) => r.provider)).not.toContain(
      'europeana',
    );
  });

  it('falls back to literal[0] when literal[1] is missing, and drops empty queries', () => {
    expect(planTier1Requests(['only'], 'videos')).toEqual([
      { provider: 'pexels', kind: 'video', query: 'only' },
      { provider: 'pixabay', kind: 'video', query: 'only' },
    ]);
    expect(planTier1Requests([], 'mixed')).toEqual([]);
  });
});

describe('passesHygiene', () => {
  it('drops videos shorter than 2 s', () => {
    expect(passesHygiene(candidate({ duration: 1.5 }), 1080)).toBe(false);
    expect(passesHygiene(candidate({ duration: 2 }), 1080)).toBe(true);
  });
  it('drops resolution below 60% of target height', () => {
    expect(passesHygiene(candidate({ height: 600 }), 1080)).toBe(false);
    expect(passesHygiene(candidate({ height: 700 }), 1080)).toBe(true);
  });
  it('drops extreme aspect ratios', () => {
    expect(passesHygiene(candidate({ width: 4000, height: 1000 }), 1080)).toBe(false);
    expect(passesHygiene(candidate({ width: 1080, height: 4000 }), 1080)).toBe(false);
  });
});

describe('matchesOrientation', () => {
  it('accepts aspect within ±20% of the target', () => {
    expect(matchesOrientation(1920, 1080, 'landscape')).toBe(true);
    expect(matchesOrientation(1080, 1920, 'portrait')).toBe(true);
    expect(matchesOrientation(1000, 1000, 'square')).toBe(true);
  });
  it('rejects clear orientation mismatches', () => {
    expect(matchesOrientation(1080, 1920, 'landscape')).toBe(false);
    expect(matchesOrientation(1920, 1080, 'portrait')).toBe(false);
  });
  it('keeps candidates with unknown geometry', () => {
    expect(matchesOrientation(0, 0, 'landscape')).toBe(true);
  });
});

describe('aspect mapping', () => {
  it('maps aspect to orientation and target height', () => {
    expect(orientationForAspect('9:16')).toBe('portrait');
    expect(orientationForAspect('16:9')).toBe('landscape');
    expect(orientationForAspect('1:1')).toBe('square');
    expect(targetHeightForAspect('9:16')).toBe(1920);
    expect(targetHeightForAspect('16:9')).toBe(1080);
  });
});

describe('quota windows', () => {
  it('truncates to UTC window starts', () => {
    const d = new Date('2026-07-11T13:47:29.512Z');
    expect(truncateWindow(d, 'minute').toISOString()).toBe('2026-07-11T13:47:00.000Z');
    expect(truncateWindow(d, 'hour').toISOString()).toBe('2026-07-11T13:00:00.000Z');
    expect(truncateWindow(d, 'day').toISOString()).toBe('2026-07-11T00:00:00.000Z');
    expect(truncateWindow(d, 'month').toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
  it('exposes budgets for every provider window', () => {
    const pixabay = QUOTA_BUDGETS.find((b) => b.key === 'pixabay:minute');
    expect(pixabay?.budget).toBe(PIXABAY_MINUTE_BUDGET);
    expect(QUOTA_BUDGETS.map((b) => b.key).sort()).toEqual([
      'europeana:hour',
      'flickr:hour',
      'inaturalist:hour',
      'internet-archive:hour',
      'library-of-congress:hour',
      'met:hour',
      'nasa:hour',
      'openverse:day',
      'pexels:hour',
      'pexels:month',
      'pixabay:minute',
      'smithsonian:hour',
      'usgs:hour',
      'wikidata-commons:hour',
      'wikimedia:hour',
    ]);
    expect([...new Set(QUOTA_BUDGETS.map((b) => b.unit))].sort()).toEqual([
      'day',
      'hour',
      'minute',
      'month',
    ]);
  });
});
