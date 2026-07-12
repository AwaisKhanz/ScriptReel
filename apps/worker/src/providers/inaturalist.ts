import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// iNaturalist (doc 25 §2): keyless CC0/CC-BY nature observation photos. One call —
// observations embed their photos, so there is no second fetch. The query pre-filters to
// cc0,cc-by, and the per-item license string still round-trips the core license gate.
// Every failure degrades to [] (invariant 7). iNat asks for a descriptive User-Agent.
const INAT_SEARCH = 'https://api.inaturalist.org/v1/observations';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;

const INatPhoto = z.object({
  id: z.number().nullish(),
  license_code: z.string().nullish(),
  url: z.string().nullish(), // a `.../square.jpg` rendition
  original_dimensions: z
    .object({ width: z.number().nullish(), height: z.number().nullish() })
    .nullish(),
});
const INatObservation = z.object({
  id: z.number().nullish(),
  species_guess: z.string().nullish(),
  taxon: z.object({ preferred_common_name: z.string().nullish() }).nullish(),
  user: z.object({ name: z.string().nullish(), login: z.string().nullish() }).nullish(),
  photos: z.array(INatPhoto).nullish(),
});
export type INatObservation = z.infer<typeof INatObservation>;
const INatResponse = z.object({ results: z.array(INatObservation).nullish() });

// iNaturalist photo URLs carry the rendition as the filename token (`.../square.jpg`);
// swap it to fetch a different size. `original` = full-res download, `medium` = thumb.
// Unknown-shaped URLs are returned unchanged (the replace is a no-op).
export function swapInatPhotoSize(url: string, size: 'original' | 'medium'): string {
  return url.replace('/square.', `/${size}.`);
}

// iNat's license_code → a string the core license gate accepts. The query already filters
// to cc0,cc-by; anything else passes straight through for the gate to reject.
export function mapInatLicense(code: string | null | undefined): string {
  const c = (code ?? '').toLowerCase().trim();
  if (c === 'cc0') return 'CC0';
  if (c === 'cc-by') return 'CC-BY';
  return code ?? '';
}

// Pure: one candidate per observation's first photo (skip observations with no usable
// photo). Geometry comes from original_dimensions (0/0 when absent — hygiene keeps it).
export function toINatCandidates(observations: readonly INatObservation[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const obs of observations) {
    const photo = (obs.photos ?? [])[0];
    const url = photo?.url ?? '';
    if (!photo || url.length === 0) continue; // needs a real photo URL
    out.push({
      provider: 'inaturalist',
      providerId: String(photo.id ?? obs.id ?? ''),
      kind: 'image',
      width: photo.original_dimensions?.width ?? 0,
      height: photo.original_dimensions?.height ?? 0,
      thumbUrl: swapInatPhotoSize(url, 'medium'),
      downloadUrl: swapInatPhotoSize(url, 'original'),
      pageUrl: obs.id != null ? `https://www.inaturalist.org/observations/${obs.id}` : '',
      author: obs.user?.name || obs.user?.login || 'iNaturalist',
      license: mapInatLicense(photo.license_code), // 'CC0' | 'CC-BY' — round-trips the gate
      meta: {
        source: 'inaturalist',
        title: obs.taxon?.preferred_common_name || obs.species_guess || '',
      },
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

export class INaturalistProvider implements MediaProvider {
  readonly id = 'inaturalist' as const;

  // `_auth` is keyless (kept for the MediaProvider contract): the iNaturalist API takes
  // no key.
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // iNaturalist is image-only

    const url = new URL(INAT_SEARCH);
    url.searchParams.set('q', query.query);
    url.searchParams.set('photos', 'true');
    url.searchParams.set('photo_license', 'cc0,cc-by');
    url.searchParams.set('per_page', String(query.perPage));
    url.searchParams.set('order_by', 'votes');
    url.searchParams.set('order', 'desc');

    const parsed = INatResponse.safeParse(await getJson(url));
    if (!parsed.success) return [];
    return toINatCandidates(parsed.data.results ?? []);
  }
}
