import { describe, expect, it } from 'vitest';
import { toWellcomeCandidates, type WellcomeImage } from './wellcome';

const IIIF = 'https://iiif.wellcomecollection.org/image/L0000245/info.json';

function image(overrides: Partial<WellcomeImage> = {}): WellcomeImage {
  return {
    id: 'a2yunera',
    thumbnail: { url: IIIF, credit: 'Wellcome Collection', license: { id: 'pdm' } },
    locations: [
      {
        url: IIIF,
        credit: 'Wellcome Collection',
        license: { id: 'pdm' },
        locationType: { id: 'iiif-image' },
      },
    ],
    source: { id: 'wsrc123', title: "Doctor's surgery, 1890" },
    ...overrides,
  };
}

describe('toWellcomeCandidates', () => {
  it('renders IIIF URLs, passes the license through, links to the source work', () => {
    const [c] = toWellcomeCandidates([image()]);
    expect(c?.provider).toBe('wellcome');
    expect(c?.providerId).toBe('a2yunera');
    expect(c?.kind).toBe('image');
    // info.json → a rendered JPEG at the requested width
    expect(c?.downloadUrl).toBe(
      'https://iiif.wellcomecollection.org/image/L0000245/full/1600,/0/default.jpg',
    );
    expect(c?.thumbUrl).toBe(
      'https://iiif.wellcomecollection.org/image/L0000245/full/400,/0/default.jpg',
    );
    expect(c?.license).toBe('pdm'); // round-trips the core gate (PDM allowed)
    expect(c?.pageUrl).toBe('https://wellcomecollection.org/works/wsrc123');
    expect(c?.author).toBe('Wellcome Collection');
    expect(c?.width).toBe(0); // IIIF — dimensions unknown here (neutral in scoring)
  });

  it('falls back to the thumbnail location when locations[] has no iiif-image', () => {
    const [c] = toWellcomeCandidates([image({ locations: [] })]);
    expect(c?.downloadUrl).toContain('/full/1600,/0/default.jpg');
    expect(c?.license).toBe('pdm');
  });

  it('skips images with no renderable IIIF location', () => {
    expect(
      toWellcomeCandidates([
        image({
          thumbnail: null,
          locations: [
            { url: 'https://example.org/not-iiif.jpg', locationType: { id: 'iiif-image' } },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it('skips images with no license (the gate would reject anyway)', () => {
    expect(
      toWellcomeCandidates([
        image({ thumbnail: null, locations: [{ url: IIIF, locationType: { id: 'iiif-image' } }] }),
      ]),
    ).toEqual([]);
  });
});
