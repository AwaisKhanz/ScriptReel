import {
  applyAuth,
  type MediaProvider,
  type RawCandidate,
  type RequestAuth,
  type SearchQuery,
} from '@scriptreel/core';
import { z } from 'zod';

// NASA image library (doc 23): public-domain space/science/Earth imagery, no key.
// Image-only here (video needs a second asset-manifest call — a later slice).
const NASA_BASE = 'https://images-api.nasa.gov/search';

const Item = z.object({
  href: z.string().nullish(),
  data: z
    .array(
      z.object({
        nasa_id: z.string(),
        title: z.string().nullish(),
        center: z.string().nullish(),
        keywords: z.array(z.string()).nullish(),
      }),
    )
    .nullish(),
  links: z.array(z.object({ href: z.string().nullish(), render: z.string().nullish() })).nullish(),
});
const NasaResponse = z.object({
  collection: z.object({ items: z.array(Item).nullish() }).nullish(),
});

// The image links are previews (…~thumb.jpg); the full asset swaps the size token.
function fullRes(preview: string): string {
  return preview.replace(/~(thumb|small|medium|large)\.(jpe?g|png)$/i, '~orig.$2');
}

export class NasaProvider implements MediaProvider {
  readonly id = 'nasa' as const;

  async search(query: SearchQuery, auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // image-only for now

    const url = new URL(NASA_BASE);
    url.searchParams.set('q', query.query);
    url.searchParams.set('media_type', 'image');
    url.searchParams.set('page_size', String(query.perPage));

    const headers: Record<string, string> = {
      'user-agent': 'ScriptReel/1.0 (local script-to-video)',
    };
    applyAuth(url, headers, auth); // optional ?api_key=<key> (anonymous otherwise)
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`nasa /search → HTTP ${res.status}`);
    const parsed = NasaResponse.parse(await res.json());

    const out: RawCandidate[] = [];
    for (const item of parsed.collection?.items ?? []) {
      const meta = (item.data ?? [])[0];
      const preview = (item.links ?? []).find((l) => l.href)?.href;
      if (!meta || !preview) continue;
      out.push({
        provider: 'nasa',
        providerId: meta.nasa_id,
        kind: 'image',
        width: 0, // unknown until download; hygiene keeps unknown-geometry candidates
        height: 0,
        thumbUrl: preview,
        downloadUrl: fullRes(preview),
        pageUrl: `https://images.nasa.gov/details-${encodeURIComponent(meta.nasa_id)}`,
        author: meta.center ? `NASA / ${meta.center}` : 'NASA',
        license: 'public domain', // NASA media is generally public domain (doc 22)
        meta: {
          nasaId: meta.nasa_id,
          ...(meta.keywords ? { keywords: meta.keywords.slice(0, 5) } : {}),
        },
      });
    }
    return out;
  }
}
