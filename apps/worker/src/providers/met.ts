import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import pLimit from 'p-limit';
import { z } from 'zod';

// The Metropolitan Museum of Art Open Access (doc 25 §2): keyless, CC0 public-domain
// artworks/artifacts. Image-only. A search returns objectIDs; each object is a second
// call, so we cap the list and bound the fan-out. Every failure degrades to [] (the
// search stage then falls back to stock — invariant 7). Met requires a descriptive UA.
const MET_SEARCH = 'https://collectionapi.metmuseum.org/public/collection/v1/search';
const MET_OBJECT = 'https://collectionapi.metmuseum.org/public/collection/v1/objects';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;
const MAX_OBJECTS = 8; // objectIDs to resolve per search — bounds the second-call fan-out
const OBJECT_PARALLELISM = 4;

const MetSearchResponse = z.object({
  total: z.number().nullish(),
  objectIDs: z.array(z.number()).nullish(),
});

const MetObject = z.object({
  objectID: z.number(),
  title: z.string().nullish(),
  artistDisplayName: z.string().nullish(),
  primaryImage: z.string().nullish(),
  primaryImageSmall: z.string().nullish(),
  isPublicDomain: z.boolean().nullish(),
  objectURL: z.string().nullish(),
});
export type MetObject = z.infer<typeof MetObject>;

// Pure: keep only CC0 public-domain objects that actually carry a full-res image and map
// each to a RawCandidate. Geometry is unknown until download (0/0) — hygiene keeps
// unknown-geometry images, same as nasa.ts.
export function toMetCandidates(objects: readonly MetObject[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const o of objects) {
    if (o.isPublicDomain !== true) continue;
    const primaryImage = o.primaryImage ?? '';
    if (primaryImage.length === 0) continue; // needs a real full-res URL
    const primaryImageSmall = o.primaryImageSmall ?? '';
    out.push({
      provider: 'met',
      providerId: String(o.objectID),
      kind: 'image',
      width: 0, // unknown until download; hygiene keeps unknown-geometry candidates
      height: 0,
      thumbUrl: primaryImageSmall || primaryImage,
      downloadUrl: primaryImage,
      pageUrl: o.objectURL ?? '',
      author: o.artistDisplayName || 'The Met',
      license: 'CC0', // Met Open Access is CC0 — round-trips the license gate
      meta: { source: 'the met', title: o.title ?? '' },
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

export class MetProvider implements MediaProvider {
  readonly id = 'met' as const;

  // `_auth` is keyless (kept for the MediaProvider contract): the Met Collection API
  // takes no key.
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Met is image-only

    const searchUrl = new URL(MET_SEARCH);
    searchUrl.searchParams.set('q', query.query);
    searchUrl.searchParams.set('hasImages', 'true');
    const searchParsed = MetSearchResponse.safeParse(await getJson(searchUrl));
    if (!searchParsed.success) return [];

    const ids = (searchParsed.data.objectIDs ?? []).slice(0, MAX_OBJECTS);
    if (ids.length === 0) return [];

    const limit = pLimit(OBJECT_PARALLELISM);
    const objects = await Promise.all(
      ids.map((id) =>
        limit(async () => {
          try {
            const parsed = MetObject.safeParse(await getJson(new URL(`${MET_OBJECT}/${id}`)));
            return parsed.success ? parsed.data : null; // parse failure → skip that item
          } catch {
            return null; // one object 404/timeout must not drop the rest of the batch
          }
        }),
      ),
    );
    return toMetCandidates(objects.filter((o): o is MetObject => o !== null));
  }
}
