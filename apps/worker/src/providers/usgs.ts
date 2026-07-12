import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// USGS ScienceBase (doc 25 §2): keyless public-domain federal science imagery. One call —
// the catalog item carries its file list inline. Federal works are public domain, so the
// per-item license is 'public domain' (round-trips the core gate). Every failure degrades
// to [] (invariant 7). ScienceBase asks for a descriptive User-Agent.
const SB_ITEMS = 'https://www.sciencebase.gov/catalog/items';
const SB_ITEM = 'https://www.sciencebase.gov/catalog/item';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;

const SbFile = z.object({
  name: z.string().nullish(),
  contentType: z.string().nullish(),
  url: z.string().nullish(),
  downloadUri: z.string().nullish(),
  imageWidth: z.number().nullish(),
  imageHeight: z.number().nullish(),
  previewImage: z
    .object({
      small: z.object({ uri: z.string().nullish() }).nullish(),
      medium: z.object({ uri: z.string().nullish() }).nullish(),
    })
    .nullish(),
});
const SbItem = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  files: z.array(SbFile).nullish(),
});
export type SbItem = z.infer<typeof SbItem>;
const SbResponse = z.object({ items: z.array(SbItem).nullish() });

// Pure: one candidate per item that carries a usable image file (contentType image/*
// with a real url). Thumb prefers the small/medium preview render, else the full file.
export function toUsgsCandidates(items: readonly SbItem[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const item of items) {
    const file = (item.files ?? []).find(
      (f) =>
        (f.contentType ?? '').startsWith('image/') && (f.url ?? f.downloadUri ?? '').length > 0,
    );
    if (!file) continue; // no usable image file
    const download = file.url ?? file.downloadUri ?? '';
    const thumb = file.previewImage?.small?.uri || file.previewImage?.medium?.uri || download;
    out.push({
      provider: 'usgs',
      providerId: item.id ?? download,
      kind: 'image',
      width: file.imageWidth ?? 0,
      height: file.imageHeight ?? 0,
      thumbUrl: thumb,
      downloadUrl: download,
      pageUrl: item.id ? `${SB_ITEM}/${item.id}` : '',
      author: 'USGS',
      license: 'public domain', // ScienceBase federal work — round-trips the gate
      meta: { source: 'usgs sciencebase', title: item.title ?? '' },
    });
  }
  return out;
}

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

export class UsgsProvider implements MediaProvider {
  readonly id = 'usgs' as const;

  // `_auth` is keyless (kept for the MediaProvider contract): the ScienceBase catalog
  // takes no key.
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // USGS is image-only

    const url = new URL(SB_ITEMS);
    url.searchParams.set('q', query.query);
    // URLSearchParams encodes the '=' as %3D → filter=browseCategory%3DImage.
    url.searchParams.set('filter', 'browseCategory=Image');
    url.searchParams.set('format', 'json');
    url.searchParams.set('max', String(query.perPage));
    url.searchParams.set('fields', 'title,files,body');

    const parsed = SbResponse.safeParse(await getJson(url));
    if (!parsed.success) return [];
    return toUsgsCandidates(parsed.data.items ?? []);
  }
}
