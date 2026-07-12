import {
  applyAuth,
  type MediaProvider,
  type RawCandidate,
  type RequestAuth,
  type SearchQuery,
} from '@scriptreel/core';
import { z } from 'zod';

// Flickr (doc 25 §2): keyed photo search restricted to the CC/PD license ids. One call.
// The REST API returns HTTP 200 even on error, so success is gated on `stat === 'ok'`.
// The per-item license id maps to a string the core license gate accepts. No key
// configured ⇒ [] (nothing to do). Every failure degrades to [] (invariant 7).
const FLICKR_REST = 'https://www.flickr.com/services/rest/';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;

const FlickrPhoto = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  owner: z.string().nullish(),
  ownername: z.string().nullish(),
  title: z.string().nullish(),
  license: z.union([z.string(), z.number()]).nullish(),
  url_o: z.string().nullish(),
  url_l: z.string().nullish(),
  url_c: z.string().nullish(),
  url_m: z.string().nullish(),
  width_l: z.union([z.string(), z.number()]).nullish(),
  height_l: z.union([z.string(), z.number()]).nullish(),
});
export type FlickrPhoto = z.infer<typeof FlickrPhoto>;
const FlickrResponse = z.object({
  stat: z.string().nullish(),
  photos: z.object({ photo: z.array(FlickrPhoto).nullish() }).nullish(),
});

// Flickr numeric license id → a string the core license gate accepts. We only request the
// allowed set (4,7,8,9,10) but map each explicitly so the per-item license round-trips.
// 4 = CC BY, 7 = No known copyright, 8 = US Gov Work, 9 = CC0, 10 = Public Domain Mark.
export function mapFlickrLicense(id: number | string | null | undefined): string {
  switch (String(id)) {
    case '4':
      return 'CC-BY';
    case '9':
      return 'CC0';
    case '7':
    case '8':
    case '10':
      return 'public domain';
    default:
      return '';
  }
}

// Minimal HTML entity unescape for Flickr titles (they arrive HTML-escaped). `&amp;` is
// decoded last so a single pass never double-decodes (e.g. `&amp;lt;` → `&lt;`, not `<`).
export function unescapeHtml(s: string): string {
  return s
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function toNum(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? Number.NaN);
  return Number.isFinite(n) ? n : 0;
}

// Pure: one candidate per photo that carries a usable image url. downloadUrl prefers the
// original, then large, then medium-large; thumb prefers the medium-large render.
export function toFlickrCandidates(photos: readonly FlickrPhoto[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const p of photos) {
    const download = p.url_o || p.url_l || p.url_c || '';
    if (download.length === 0) continue; // no usable image url
    const id = String(p.id ?? '');
    const owner = p.owner ?? '';
    out.push({
      provider: 'flickr',
      providerId: id,
      kind: 'image',
      width: toNum(p.width_l),
      height: toNum(p.height_l),
      thumbUrl: p.url_c || p.url_m || p.url_l || download,
      downloadUrl: download,
      pageUrl: owner && id ? `https://www.flickr.com/photos/${owner}/${id}` : '',
      author: p.ownername || 'Flickr',
      license: mapFlickrLicense(p.license), // 'CC-BY' | 'CC0' | 'public domain'
      meta: { source: 'flickr', title: unescapeHtml(p.title ?? '') },
    });
  }
  return out;
}

export class FlickrProvider implements MediaProvider {
  readonly id = 'flickr' as const;

  async search(query: SearchQuery, auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Flickr is image-only here
    if (auth.kind === 'none') return []; // no key configured → nothing to do

    const url = new URL(FLICKR_REST);
    url.searchParams.set('method', 'flickr.photos.search');
    url.searchParams.set('text', query.query);
    url.searchParams.set('license', '4,7,8,9,10'); // CC-BY / PD / CC0 only
    url.searchParams.set('media', 'photos');
    url.searchParams.set('content_types', '0');
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('safe_search', '1');
    url.searchParams.set('extras', 'license,owner_name,url_l,url_c,url_o,o_dims');
    url.searchParams.set('per_page', String(query.perPage));
    url.searchParams.set('page', '1');
    url.searchParams.set('format', 'json');
    url.searchParams.set('nojsoncallback', '1');

    const headers: Record<string, string> = { 'user-agent': UA };
    applyAuth(url, headers, auth); // api_key query param
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return [];
    const parsed = FlickrResponse.safeParse(await res.json());
    if (!parsed.success || parsed.data.stat !== 'ok') return []; // 200-with-error body
    return toFlickrCandidates(parsed.data.photos?.photo ?? []);
  }
}
