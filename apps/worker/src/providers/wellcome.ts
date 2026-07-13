import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// Wellcome Collection (medicine / anatomy / human body / doctors / medical history) — keyless
// catalogue API, THE gap-filler for medical beats. Chosen over PMC/Open-i because its per-item
// licensing is clean CC0 / CC-BY / PDM (Open-i's per-image licenses are variable and mostly
// rejected by the no-strike gate). Uses the dedicated /images endpoint (every result is an image,
// unlike /works). Images are served by the IIIF Image API. Every failure degrades to [] (invariant
// 7); Wellcome asks for a descriptive User-Agent.
const IMAGES = 'https://api.wellcomecollection.org/catalogue/v2/images';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;
const RENDER_WIDTH = 1600; // IIIF full/{w},/ render — a bounded large size (~HD)
const THUMB_WIDTH = 400;

const License = z.object({ id: z.string().nullish() }).nullish();
const Location = z.object({
  url: z.string().nullish(), // IIIF ".../image/{id}/info.json"
  credit: z.string().nullish(),
  license: License,
  locationType: z.object({ id: z.string().nullish() }).nullish(),
});
const WellcomeImageSchema = z.object({
  id: z.string().nullish(),
  thumbnail: Location.nullish(),
  locations: z.array(Location).nullish(),
  source: z.object({ id: z.string().nullish(), title: z.string().nullish() }).nullish(),
});
export type WellcomeImage = z.infer<typeof WellcomeImageSchema>;
const ImagesResponse = z.object({ results: z.array(WellcomeImageSchema).nullish() });

// IIIF Image API: a location's `url` is ".../image/{id}/info.json"; the rendered JPEG is
// ".../image/{id}/full/{width},/0/default.jpg". Returns '' if it isn't an info.json URL.
function iiifJpeg(infoUrl: string, width: number): string {
  return /\/info\.json$/i.test(infoUrl)
    ? infoUrl.replace(/\/info\.json$/i, `/full/${width},/0/default.jpg`)
    : '';
}

// Pure: one candidate per image that carries a usable IIIF Image location. The license id
// (pdm | cc0 | cc-by | …) round-trips the core gate, which drops nc/nd/sa. Dimensions live in the
// IIIF info.json, not the search response, so width/height are 0 (unknown → neutral, doc 24 §7).
export function toWellcomeCandidates(images: readonly WellcomeImage[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const img of images) {
    const loc =
      (img.locations ?? []).find(
        (l) => l.locationType?.id === 'iiif-image' && (l.url ?? '').length > 0,
      ) ?? img.thumbnail;
    const download = iiifJpeg(loc?.url ?? '', RENDER_WIDTH);
    if (!download) continue; // no renderable IIIF image
    const license = loc?.license?.id ?? img.thumbnail?.license?.id ?? '';
    if (!license) continue; // unstated ⇒ the gate would reject anyway
    const sourceId = img.source?.id ?? '';
    out.push({
      provider: 'wellcome',
      providerId: img.id ?? download,
      kind: 'image',
      width: 0,
      height: 0,
      thumbUrl: iiifJpeg(loc?.url ?? '', THUMB_WIDTH) || download,
      downloadUrl: download,
      pageUrl: sourceId ? `https://wellcomecollection.org/works/${sourceId}` : '',
      author: loc?.credit || 'Wellcome Collection',
      license,
      meta: { source: 'wellcome collection', title: img.source?.title ?? '' },
    });
  }
  return out;
}

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

export class WellcomeProvider implements MediaProvider {
  readonly id = 'wellcome' as const;

  // Keyless — the Wellcome catalogue API takes no key (`_auth` kept for the contract).
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Wellcome is image-only

    const url = new URL(IMAGES);
    url.searchParams.set('query', query.query);
    // Only openly-licensed images (defense-in-depth; the core license gate is authoritative).
    url.searchParams.set('locations.license', 'cc0,cc-by,pdm');
    url.searchParams.set('pageSize', String(query.perPage));

    const parsed = ImagesResponse.safeParse(await getJson(url));
    if (!parsed.success) return [];
    return toWellcomeCandidates(parsed.data.results ?? []);
  }
}
