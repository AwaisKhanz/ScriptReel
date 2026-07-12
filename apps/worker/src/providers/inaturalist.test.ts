import { describe, expect, it } from 'vitest';
import {
  type INatObservation,
  mapInatLicense,
  swapInatPhotoSize,
  toINatCandidates,
} from './inaturalist';

const obs: INatObservation = {
  id: 42,
  species_guess: 'red fox',
  taxon: { preferred_common_name: 'Red Fox' },
  user: { name: 'Jane Doe', login: 'jdoe' },
  photos: [
    {
      id: 999,
      license_code: 'cc-by',
      url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/999/square.jpg',
      original_dimensions: { width: 2048, height: 1536 },
    },
  ],
};

describe('swapInatPhotoSize', () => {
  it('swaps the square token to original and medium', () => {
    const url = 'https://x/photos/1/square.jpg';
    expect(swapInatPhotoSize(url, 'original')).toBe('https://x/photos/1/original.jpg');
    expect(swapInatPhotoSize(url, 'medium')).toBe('https://x/photos/1/medium.jpg');
  });

  it('leaves a URL without the size token unchanged', () => {
    expect(swapInatPhotoSize('https://x/photos/1/thumb.jpg', 'original')).toBe(
      'https://x/photos/1/thumb.jpg',
    );
  });
});

describe('mapInatLicense', () => {
  it('maps the two allowed codes to gate-friendly strings', () => {
    expect(mapInatLicense('cc0')).toBe('CC0');
    expect(mapInatLicense('cc-by')).toBe('CC-BY');
  });

  it('passes anything else straight through, empty for missing', () => {
    expect(mapInatLicense('cc-by-nc')).toBe('cc-by-nc');
    expect(mapInatLicense(null)).toBe('');
    expect(mapInatLicense(undefined)).toBe('');
  });
});

describe('toINatCandidates', () => {
  it('maps an observation to one image candidate with swapped urls', () => {
    const [c, ...rest] = toINatCandidates([obs]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'inaturalist',
      providerId: '999',
      kind: 'image',
      width: 2048,
      height: 1536,
      downloadUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/999/original.jpg',
      thumbUrl: 'https://inaturalist-open-data.s3.amazonaws.com/photos/999/medium.jpg',
      pageUrl: 'https://www.inaturalist.org/observations/42',
      author: 'Jane Doe',
      license: 'CC-BY',
    });
  });

  it('drops observations with no photo or no url', () => {
    expect(toINatCandidates([{ ...obs, photos: [] }])).toEqual([]);
    expect(toINatCandidates([{ ...obs, photos: [{ id: 1, url: '' }] }])).toEqual([]);
  });

  it('falls back to the login, then a default author, and 0/0 geometry', () => {
    const [c] = toINatCandidates([
      {
        ...obs,
        user: { login: 'jdoe' },
        photos: [{ id: 1, license_code: 'cc0', url: 'https://x/photos/1/square.jpg' }],
      },
    ]);
    expect(c?.author).toBe('jdoe');
    expect(c?.width).toBe(0);
    expect(c?.height).toBe(0);
    expect(c?.license).toBe('CC0');
  });
});
