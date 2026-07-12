import { describe, expect, it } from 'vitest';
import { type EuropeanaItem, toEuropeanaCandidates } from './europeana';

const item: EuropeanaItem = {
  id: '/2021012/xyz',
  guid: 'https://www.europeana.eu/item/2021012/xyz',
  title: ['The Night Watch'],
  dcCreator: ['Rembrandt'],
  edmIsShownBy: ['https://media.example.org/full.jpg'],
  edmPreview: ['https://media.example.org/thumb.jpg'],
  rights: ['http://creativecommons.org/publicdomain/mark/1.0/'],
};

describe('toEuropeanaCandidates', () => {
  it('takes the first element of each array field', () => {
    const [c, ...rest] = toEuropeanaCandidates([item]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'europeana',
      providerId: '/2021012/xyz',
      kind: 'image',
      width: 0,
      height: 0,
      downloadUrl: 'https://media.example.org/full.jpg',
      thumbUrl: 'https://media.example.org/thumb.jpg',
      pageUrl: 'https://www.europeana.eu/item/2021012/xyz',
      author: 'Rembrandt',
      license: 'http://creativecommons.org/publicdomain/mark/1.0/',
    });
    expect(c?.meta?.title).toBe('The Night Watch');
  });

  it('drops items with no direct media link (edmIsShownBy absent)', () => {
    expect(toEuropeanaCandidates([{ ...item, edmIsShownBy: [] }])).toEqual([]);
    expect(toEuropeanaCandidates([{ ...item, edmIsShownBy: undefined }])).toEqual([]);
  });

  it('falls back to the media link for the thumb and to Unknown author', () => {
    const [c] = toEuropeanaCandidates([
      { edmIsShownBy: ['https://media.example.org/only.jpg'], rights: ['CC0'] },
    ]);
    expect(c?.thumbUrl).toBe('https://media.example.org/only.jpg');
    expect(c?.author).toBe('Unknown');
    expect(c?.license).toBe('CC0');
  });
});
