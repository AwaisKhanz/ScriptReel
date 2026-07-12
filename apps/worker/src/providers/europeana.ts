import {
  applyAuth,
  type MediaProvider,
  type RawCandidate,
  type RequestAuth,
  type SearchQuery,
} from '@scriptreel/core';
import { z } from 'zod';

// Europeana (doc 25 §2): keyed open cultural-heritage image search. One call — the rich
// profile embeds the direct media link (edmIsShownBy) and a preview. `reusability=open`
// still leaks CC-BY-SA, so the per-item rights URL is emitted verbatim and the core
// license gate drops the ShareAlike ones. No key ⇒ []. Every failure degrades to []
// (invariant 7). Most item fields are arrays — take the first element.
const EUROPEANA_SEARCH = 'https://api.europeana.eu/record/v2/search.json';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;

const EuropeanaItem = z.object({
  id: z.string().nullish(),
  guid: z.string().nullish(),
  title: z.array(z.string()).nullish(),
  dcCreator: z.array(z.string()).nullish(),
  edmIsShownBy: z.array(z.string()).nullish(),
  edmPreview: z.array(z.string()).nullish(),
  rights: z.array(z.string()).nullish(),
});
export type EuropeanaItem = z.infer<typeof EuropeanaItem>;
const EuropeanaResponse = z.object({ items: z.array(EuropeanaItem).nullish() });

// Pure: one candidate per item that carries a direct media link. Geometry is unknown
// (0/0). The rights URL passes straight to the core gate (open ⇒ still may be SA).
export function toEuropeanaCandidates(items: readonly EuropeanaItem[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const item of items) {
    const download = (item.edmIsShownBy ?? [])[0] ?? '';
    if (download.length === 0) continue; // rich-profile direct media link required
    out.push({
      provider: 'europeana',
      providerId: item.id ?? download,
      kind: 'image',
      width: 0, // unknown until download; hygiene keeps unknown-geometry candidates
      height: 0,
      thumbUrl: (item.edmPreview ?? [])[0] || download,
      downloadUrl: download,
      pageUrl: item.guid ?? '',
      author: (item.dcCreator ?? [])[0] || 'Unknown',
      license: (item.rights ?? [])[0] ?? '', // a license URL — the core gate classifies it
      meta: { source: 'europeana', title: (item.title ?? [])[0] ?? '' },
    });
  }
  return out;
}

export class EuropeanaProvider implements MediaProvider {
  readonly id = 'europeana' as const;

  async search(query: SearchQuery, auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Europeana is image-only here
    if (auth.kind === 'none') return []; // no key configured → nothing to do

    const url = new URL(EUROPEANA_SEARCH);
    url.searchParams.set('query', query.query);
    url.searchParams.set('qf', 'TYPE:IMAGE');
    url.searchParams.set('reusability', 'open');
    url.searchParams.set('media', 'true');
    url.searchParams.set('thumbnail', 'true');
    url.searchParams.set('profile', 'rich'); // exposes edmIsShownBy (the direct media link)
    url.searchParams.set('rows', String(query.perPage));
    url.searchParams.set('start', '1');

    const headers: Record<string, string> = { 'user-agent': UA };
    applyAuth(url, headers, auth); // wskey query param
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return [];
    const parsed = EuropeanaResponse.safeParse(await res.json());
    if (!parsed.success) return [];
    return toEuropeanaCandidates(parsed.data.items ?? []);
  }
}
