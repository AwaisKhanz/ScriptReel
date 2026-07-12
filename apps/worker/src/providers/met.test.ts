import { describe, expect, it } from 'vitest';
import { type MetObject, toMetCandidates } from './met';

const pdWithImage: MetObject = {
  objectID: 436535,
  title: 'Wheat Field with Cypresses',
  artistDisplayName: 'Vincent van Gogh',
  primaryImage: 'https://images.metmuseum.org/CRDImages/ep/original/DT1567.jpg',
  primaryImageSmall: 'https://images.metmuseum.org/CRDImages/ep/web-large/DT1567.jpg',
  isPublicDomain: true,
  objectURL: 'https://www.metmuseum.org/art/collection/search/436535',
};

describe('toMetCandidates', () => {
  it('maps a public-domain object with an image to one CC0 candidate', () => {
    const [c, ...rest] = toMetCandidates([pdWithImage]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'met',
      providerId: '436535',
      kind: 'image',
      width: 0,
      height: 0,
      thumbUrl: pdWithImage.primaryImageSmall,
      downloadUrl: pdWithImage.primaryImage,
      pageUrl: pdWithImage.objectURL,
      author: 'Vincent van Gogh',
      license: 'CC0',
    });
  });

  it('drops objects that are not public domain', () => {
    expect(toMetCandidates([{ ...pdWithImage, isPublicDomain: false }])).toEqual([]);
    expect(toMetCandidates([{ ...pdWithImage, isPublicDomain: null }])).toEqual([]);
  });

  it('drops public-domain objects with no full-res image', () => {
    expect(toMetCandidates([{ ...pdWithImage, primaryImage: '' }])).toEqual([]);
    expect(toMetCandidates([{ ...pdWithImage, primaryImage: null }])).toEqual([]);
  });

  it('falls back to the full image for the thumb and to "The Met" for the author', () => {
    const [c] = toMetCandidates([{ ...pdWithImage, primaryImageSmall: '', artistDisplayName: '' }]);
    expect(c?.thumbUrl).toBe(pdWithImage.primaryImage);
    expect(c?.author).toBe('The Met');
  });
});
