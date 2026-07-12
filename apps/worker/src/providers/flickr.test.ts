import { describe, expect, it } from 'vitest';
import { type FlickrPhoto, mapFlickrLicense, toFlickrCandidates, unescapeHtml } from './flickr';

describe('mapFlickrLicense', () => {
  it('maps each allowed numeric id to a gate-friendly string', () => {
    expect(mapFlickrLicense(4)).toBe('CC-BY');
    expect(mapFlickrLicense('9')).toBe('CC0');
    expect(mapFlickrLicense(7)).toBe('public domain');
    expect(mapFlickrLicense(8)).toBe('public domain');
    expect(mapFlickrLicense('10')).toBe('public domain');
  });

  it('returns empty for unmapped, all-rights-reserved, or missing ids', () => {
    expect(mapFlickrLicense(0)).toBe('');
    expect(mapFlickrLicense(5)).toBe('');
    expect(mapFlickrLicense(null)).toBe('');
    expect(mapFlickrLicense(undefined)).toBe('');
  });
});

describe('unescapeHtml', () => {
  it('decodes common entities without double-decoding amp', () => {
    expect(unescapeHtml('Salt &amp; Pepper')).toBe('Salt & Pepper');
    expect(unescapeHtml('&quot;Hi&quot; &lt;b&gt;')).toBe('"Hi" <b>');
    expect(unescapeHtml('it&#39;s &amp;lt;')).toBe("it's &lt;");
  });
});

describe('toFlickrCandidates', () => {
  const photo: FlickrPhoto = {
    id: 12345,
    owner: '99@N00',
    ownername: 'Ansel',
    title: 'Yosemite &amp; Half Dome',
    license: 4,
    url_o: 'https://live.staticflickr.com/o.jpg',
    url_l: 'https://live.staticflickr.com/l.jpg',
    url_c: 'https://live.staticflickr.com/c.jpg',
    width_l: '1024',
    height_l: '768',
  };

  it('maps a photo to a candidate with page url and decoded title', () => {
    const [c, ...rest] = toFlickrCandidates([photo]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'flickr',
      providerId: '12345',
      kind: 'image',
      width: 1024,
      height: 768,
      downloadUrl: 'https://live.staticflickr.com/o.jpg',
      thumbUrl: 'https://live.staticflickr.com/c.jpg',
      pageUrl: 'https://www.flickr.com/photos/99@N00/12345',
      author: 'Ansel',
      license: 'CC-BY',
    });
    expect(c?.meta?.title).toBe('Yosemite & Half Dome');
  });

  it('drops photos with no usable url and defaults geometry to 0', () => {
    expect(toFlickrCandidates([{ ...photo, url_o: '', url_l: '', url_c: '' }])).toEqual([]);
    const [c] = toFlickrCandidates([
      { id: 1, url_c: 'https://x/c.jpg', license: 9, width_l: undefined, height_l: undefined },
    ]);
    expect(c?.width).toBe(0);
    expect(c?.height).toBe(0);
    expect(c?.downloadUrl).toBe('https://x/c.jpg');
    expect(c?.license).toBe('CC0');
    expect(c?.author).toBe('Flickr');
  });
});
