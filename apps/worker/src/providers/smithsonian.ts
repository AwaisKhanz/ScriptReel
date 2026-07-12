import {
  applyAuth,
  type MediaProvider,
  type RawCandidate,
  type RequestAuth,
  type SearchQuery,
} from '@scriptreel/core';
import { z } from 'zod';

// Smithsonian Open Access (doc 25 §2): keyed CC0 museum collections. One call — the query
// pre-filters to online Images with CC0 usage, and each row embeds its media inline. The
// per-item usage.access ('CC0') is emitted and rows that are not CC0 are dropped defensively
// (round-trips the core gate). No key ⇒ []. Every failure degrades to [] (invariant 7).
const SI_SEARCH = 'https://api.si.edu/openaccess/api/v1.0/search';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;

const SiResource = z.object({
  label: z.string().nullish(),
  url: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});
const SiMedia = z.object({
  thumbnail: z.string().nullish(),
  content: z.string().nullish(), // an ids.si.edu delivery URL
  usage: z.object({ access: z.string().nullish() }).nullish(),
  resources: z.array(SiResource).nullish(),
});
const SiRow = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  content: z
    .object({
      descriptiveNonRepeating: z
        .object({
          record_link: z.string().nullish(),
          guid: z.string().nullish(),
          online_media: z.object({ media: z.array(SiMedia).nullish() }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export type SiRow = z.infer<typeof SiRow>;
const SiResponse = z.object({
  response: z.object({ rows: z.array(SiRow).nullish() }).nullish(),
});

// Pure: one candidate per row whose first online-media item is CC0 and carries an image.
// downloadUrl prefers the "High-resolution JPEG" resource (with geometry), else the
// ids.si.edu delivery URL. thumb prefers the media thumbnail, else `<content>/300`.
export function toSmithsonianCandidates(rows: readonly SiRow[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const row of rows) {
    const dnr = row.content?.descriptiveNonRepeating;
    const media = (dnr?.online_media?.media ?? [])[0];
    if (!media) continue; // no online media
    const access = media.usage?.access ?? '';
    if (access.toUpperCase() !== 'CC0') continue; // owner gate: CC0 only
    const hires = (media.resources ?? []).find((r) => r.label === 'High-resolution JPEG');
    const content = media.content ?? '';
    const download = hires?.url || content;
    if (download.length === 0) continue; // no usable image url
    out.push({
      provider: 'smithsonian',
      providerId: row.id ?? download,
      kind: 'image',
      width: hires?.width ?? 0,
      height: hires?.height ?? 0,
      thumbUrl: media.thumbnail || (content ? `${content}/300` : download),
      downloadUrl: download,
      pageUrl: dnr?.record_link || dnr?.guid || '',
      author: 'Smithsonian',
      license: access, // 'CC0' — emitted for the core gate
      meta: { source: 'smithsonian', title: row.title ?? '' },
    });
  }
  return out;
}

export class SmithsonianProvider implements MediaProvider {
  readonly id = 'smithsonian' as const;

  async search(query: SearchQuery, auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Smithsonian is image-only here
    if (auth.kind === 'none') return []; // no key configured → nothing to do

    const url = new URL(SI_SEARCH);
    // URLSearchParams encodes the whole value incl. the quotes and colons.
    url.searchParams.set('q', `${query.query} AND online_media_type:"Images" AND media_usage:CC0`);
    url.searchParams.set('rows', String(query.perPage));
    url.searchParams.set('start', '0');

    const headers: Record<string, string> = { 'user-agent': UA };
    applyAuth(url, headers, auth); // api_key query param (api.data.gov)
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return [];
    const parsed = SiResponse.safeParse(await res.json());
    if (!parsed.success) return [];
    return toSmithsonianCandidates(parsed.data.response?.rows ?? []);
  }
}
