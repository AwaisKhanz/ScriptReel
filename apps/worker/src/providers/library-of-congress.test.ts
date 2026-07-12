import { describe, expect, it } from 'vitest';
import {
  type LocResult,
  normalizeRights,
  pickLocImageUrl,
  toLocCandidates,
} from './library-of-congress';

describe('normalizeRights', () => {
  it('passes a string through', () => {
    expect(normalizeRights('No known restrictions on publication.')).toBe(
      'No known restrictions on publication.',
    );
  });

  it('joins an array of strings', () => {
    expect(normalizeRights(['No known restrictions', 'see catalog'])).toBe(
      'No known restrictions; see catalog',
    );
  });

  it('returns empty for missing or non-string shapes', () => {
    expect(normalizeRights(null)).toBe('');
    expect(normalizeRights(undefined)).toBe('');
    expect(normalizeRights(42)).toBe('');
  });
});

describe('pickLocImageUrl', () => {
  it('picks the last tile.loc.gov jpg and strips the fragment', () => {
    const urls = [
      'https://tile.loc.gov/image-services/x/full/pct:12.5/0/default.jpg#h=128&w=96',
      'https://tile.loc.gov/image-services/x/full/pct:100/0/default.jpg#h=1024&w=768',
    ];
    expect(pickLocImageUrl(urls)).toBe(
      'https://tile.loc.gov/image-services/x/full/pct:100/0/default.jpg',
    );
  });

  it('upgrades a protocol-relative URL to https', () => {
    expect(pickLocImageUrl(['//tile.loc.gov/a/default.jpg'])).toBe(
      'https://tile.loc.gov/a/default.jpg',
    );
  });

  it('skips svg and static original-format placeholders', () => {
    expect(
      pickLocImageUrl([
        'https://www.loc.gov/static/images/original-format/photo-print.svg',
        'https://tile.loc.gov/storage-services/x/default.svg',
      ]),
    ).toBeNull();
  });

  it('returns null when there is no tile.loc.gov jpg', () => {
    expect(pickLocImageUrl(['https://example.com/other.jpg'])).toBeNull();
    expect(pickLocImageUrl([])).toBeNull();
  });
});

describe('toLocCandidates', () => {
  const ok: LocResult = {
    id: 'https://www.loc.gov/item/123/',
    title: 'Main Street, 1905',
    image_url: ['https://tile.loc.gov/image-services/x/full/pct:100/0/default.jpg'],
    item: { rights_advisory: 'No known restrictions on publication.' },
  };

  it('maps a no-known-restrictions item to a public-domain candidate', () => {
    const [c, ...rest] = toLocCandidates([ok]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'library-of-congress',
      providerId: 'https://www.loc.gov/item/123/',
      kind: 'image',
      downloadUrl: 'https://tile.loc.gov/image-services/x/full/pct:100/0/default.jpg',
      pageUrl: 'https://www.loc.gov/item/123/',
      author: 'Library of Congress',
      license: 'public domain',
    });
  });

  it('drops items lacking the rights phrase or a usable image', () => {
    expect(toLocCandidates([{ ...ok, item: { rights_advisory: 'Rights unknown.' } }])).toEqual([]);
    expect(toLocCandidates([{ ...ok, item: undefined }])).toEqual([]);
    expect(toLocCandidates([{ ...ok, image_url: ['https://example.com/x.svg'] }])).toEqual([]);
  });
});
