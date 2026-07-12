import { describe, expect, it } from 'vitest';
import { type SiRow, toSmithsonianCandidates } from './smithsonian';

function row(overrides: Partial<SiRow> = {}): SiRow {
  return {
    id: 'edanmdm-1',
    title: 'Apollo 11 command module',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://www.si.edu/object/1',
        guid: 'http://n2t.net/ark:/65665/1',
        online_media: {
          media: [
            {
              thumbnail: 'https://ids.si.edu/ids/thumb1',
              content: 'https://ids.si.edu/ids/deliveryService?id=1',
              usage: { access: 'CC0' },
              resources: [
                {
                  label: 'High-resolution JPEG',
                  url: 'https://ids.si.edu/hi.jpg',
                  width: 4000,
                  height: 2600,
                },
              ],
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

describe('toSmithsonianCandidates', () => {
  it('maps a CC0 row using the high-res resource and its geometry', () => {
    const [c, ...rest] = toSmithsonianCandidates([row()]);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      provider: 'smithsonian',
      providerId: 'edanmdm-1',
      kind: 'image',
      width: 4000,
      height: 2600,
      downloadUrl: 'https://ids.si.edu/hi.jpg',
      thumbUrl: 'https://ids.si.edu/ids/thumb1',
      pageUrl: 'https://www.si.edu/object/1',
      author: 'Smithsonian',
      license: 'CC0',
    });
  });

  it('drops rows that are not CC0 or have no online media', () => {
    const notCc0 = row();
    const media = notCc0.content?.descriptiveNonRepeating?.online_media?.media?.[0];
    if (media) media.usage = { access: 'CC-BY-NC' };
    expect(toSmithsonianCandidates([notCc0])).toEqual([]);
    expect(
      toSmithsonianCandidates([
        { id: 'x', content: { descriptiveNonRepeating: { online_media: { media: [] } } } },
      ]),
    ).toEqual([]);
  });

  it('falls back to the delivery content url and a /300 thumb when no high-res resource', () => {
    const [c] = toSmithsonianCandidates([
      {
        id: 'y',
        content: {
          descriptiveNonRepeating: {
            guid: 'http://n2t.net/ark:/2',
            online_media: {
              media: [
                {
                  content: 'https://ids.si.edu/ids/deliveryService?id=2',
                  usage: { access: 'CC0' },
                },
              ],
            },
          },
        },
      },
    ]);
    expect(c?.downloadUrl).toBe('https://ids.si.edu/ids/deliveryService?id=2');
    expect(c?.thumbUrl).toBe('https://ids.si.edu/ids/deliveryService?id=2/300');
    expect(c?.pageUrl).toBe('http://n2t.net/ark:/2');
    expect(c?.width).toBe(0);
  });
});
