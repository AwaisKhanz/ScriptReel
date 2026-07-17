import { describe, expect, it } from 'vitest';
import { PIXABAY_MINUTE_BUDGET } from './constants';
import {
  matchesOrientation,
  normalizeSearchQuery,
  orientationForAspect,
  passesHygiene,
  planTier1Requests,
  providerIdSlug,
  providerLabel,
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

  // The topic/era → sources mapping is tested in topics.test.ts; here we verify planTier1Requests
  // fires whatever resolved `sources` it's handed, correctly kind-gated by the beat's media pref.
  it('fires passed image archives on mixed, gated out on videos-only', () => {
    const mixed = planTier1Requests(literal, 'mixed', ['nasa', 'wikimedia']).map(
      (r) => `${r.provider}:${r.kind}`,
    );
    expect(mixed).toContain('nasa:image');
    expect(mixed).toContain('wikimedia:image');
    // videos-only never fires image archives
    expect(planTier1Requests(literal, 'videos', ['nasa']).map((r) => r.provider)).not.toContain(
      'nasa',
    );
    // no sources ⇒ base plan only
    expect(planTier1Requests(literal, 'mixed', []).map((r) => r.provider)).not.toContain('nasa');
  });

  it('fires the Internet Archive video archive on mixed/videos, not photos', () => {
    expect(
      planTier1Requests(['x'], 'mixed', ['internet-archive']).map((r) => r.provider),
    ).toContain('internet-archive');
    expect(
      planTier1Requests(['x'], 'videos', ['internet-archive']).map((r) => r.provider),
    ).toContain('internet-archive');
    // photos-only never fires a video archive
    expect(
      planTier1Requests(['x'], 'photos', ['internet-archive']).map((r) => r.provider),
    ).not.toContain('internet-archive');
  });

  it('ignores ids that are not specialized archives (base/stock providers)', () => {
    // pexels/pixabay/openverse are the base plan, not archives — passing them adds nothing.
    const plan = planTier1Requests(literal, 'mixed', ['pexels', 'openverse']);
    const base = planTier1Requests(literal, 'mixed', []);
    expect(plan).toEqual(base);
  });

  it('queries archives with the named-subject term, stock with the generic literal', () => {
    const plan = planTier1Requests(literal, 'mixed', ['nasa', 'wikimedia'], 'apollo 11');
    // archives get the real subject — they reward the name
    expect(plan.find((r) => r.provider === 'nasa')?.query).toBe('apollo 11');
    expect(plan.find((r) => r.provider === 'wikimedia')?.query).toBe('apollo 11');
    // stock stays on the generic literal (doc 07)
    expect(plan.find((r) => r.provider === 'pexels')?.query).toBe('sunrise beach');
    expect(plan.find((r) => r.provider === 'openverse')?.query).toBe('sunrise beach');
  });

  it('falls back to the literal for archives when no subject term is given', () => {
    expect(
      planTier1Requests(['lit'], 'mixed', ['nasa']).find((r) => r.provider === 'nasa')?.query,
    ).toBe('lit');
  });

  it('falls back to literal[0] when literal[1] is missing, and drops empty queries', () => {
    expect(planTier1Requests(['only'], 'videos')).toEqual([
      { provider: 'pexels', kind: 'video', query: 'only' },
      { provider: 'pixabay', kind: 'video', query: 'only' },
    ]);
    expect(planTier1Requests([], 'mixed')).toEqual([]);
  });
});

describe('providerLabel', () => {
  it('maps provider ids to friendly names and covers ladder / unknown sources', () => {
    expect(providerLabel('library-of-congress')).toBe('Library of Congress');
    expect(providerLabel('wellcome')).toBe('Wellcome Collection');
    expect(providerLabel('wikidata-commons')).toBe('Wikimedia Commons');
    expect(providerLabel('nasa')).toBe('NASA');
    expect(providerLabel('generated')).toBe('AI image');
    expect(providerLabel('textcard')).toBe('Text card');
    expect(providerLabel('something-else')).toBe('something-else');
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
      'wellcome:hour',
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

describe('providerIdSlug', () => {
  // The whole point: re-keying a cache that already holds 16k thumbs would re-download
  // them on a metered budget and break fixtures/eval/labels.jsonl, which stores raw paths.
  it('leaves an already-safe id byte-identical', () => {
    for (const id of ['3701084', 'GSFC_20171208_Archive_e000122', 'abc-123_v2.0']) {
      expect(providerIdSlug(id)).toBe(id);
    }
  });

  it('makes a Commons title safe — the ":" that NTFS reads as an alternate data stream', () => {
    const slug = providerIdSlug('File:Voyager 1.jpg');
    expect(slug).not.toContain(':');
    expect(slug).not.toContain(' ');
    expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('makes a Library of Congress URL id safe — the "/" that demanded uncreated dirs', () => {
    const slug = providerIdSlug('https://www.loc.gov/item/123/');
    expect(slug).not.toContain('/');
    expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('makes a Europeana path id safe', () => {
    expect(providerIdSlug('/2021012/xyz')).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('keeps ids distinct that would otherwise collapse to the same slug', () => {
    expect(providerIdSlug('a/b')).not.toBe(providerIdSlug('a_b'));
    expect(providerIdSlug('File:A B.jpg')).not.toBe(providerIdSlug('File:A_B.jpg'));
  });

  it('is deterministic, and never emits a traversal or an empty name', () => {
    expect(providerIdSlug('a/b')).toBe(providerIdSlug('a/b'));
    for (const id of ['..', '.', '../../etc/passwd', '']) {
      const slug = providerIdSlug(id);
      expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
      expect(slug).not.toBe('.');
      expect(slug).not.toBe('..');
      expect(slug.includes('/')).toBe(false);
    }
  });
});
