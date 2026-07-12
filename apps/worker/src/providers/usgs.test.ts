import { describe, expect, it } from 'vitest';
import { type SbItem, toUsgsCandidates } from './usgs';

const item: SbItem = {
  id: 'abc123',
  title: 'Grand Canyon aerial',
  files: [
    { name: 'metadata.xml', contentType: 'application/xml', url: 'https://x/meta.xml' },
    {
      name: 'photo.jpg',
      contentType: 'image/jpeg',
      url: 'https://x/photo.jpg',
      imageWidth: 4000,
      imageHeight: 3000,
      previewImage: { small: { uri: 'https://x/small.jpg' } },
    },
  ],
};

describe('toUsgsCandidates', () => {
  it('maps the first image file to a public-domain candidate', () => {
    const [c, ...rest] = toUsgsCandidates([item]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'usgs',
      providerId: 'abc123',
      kind: 'image',
      width: 4000,
      height: 3000,
      downloadUrl: 'https://x/photo.jpg',
      thumbUrl: 'https://x/small.jpg',
      pageUrl: 'https://www.sciencebase.gov/catalog/item/abc123',
      author: 'USGS',
      license: 'public domain',
    });
  });

  it('drops items with no image file', () => {
    expect(
      toUsgsCandidates([
        { id: '1', files: [{ name: 'a.pdf', contentType: 'application/pdf', url: 'https://x/a' }] },
      ]),
    ).toEqual([]);
    expect(toUsgsCandidates([{ id: '2', files: [] }])).toEqual([]);
  });

  it('accepts downloadUri, falls back to the file url for the thumb, and 0/0 geometry', () => {
    const [c] = toUsgsCandidates([
      {
        id: '3',
        files: [{ name: 'i.png', contentType: 'image/png', downloadUri: 'https://x/i.png' }],
      },
    ]);
    expect(c?.downloadUrl).toBe('https://x/i.png');
    expect(c?.thumbUrl).toBe('https://x/i.png');
    expect(c?.width).toBe(0);
    expect(c?.height).toBe(0);
  });
});
