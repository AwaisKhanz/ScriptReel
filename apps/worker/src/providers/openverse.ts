import type { MediaProvider, RawCandidate, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// Openverse (doc 23): universal aggregator of copyright-free images (CC0/PD/CC-BY).
// Image-only — no video. No API key required (200/day anonymous). We ask the API to
// return only our allow-set licenses; the search-stage gate re-checks defensively.
const OV_BASE = 'https://api.openverse.org/v1/images/';

const OvResult = z.object({
  id: z.string(),
  title: z.string().nullish(),
  creator: z.string().nullish(),
  url: z.string().nullish(), // full-resolution original
  thumbnail: z.string().nullish(),
  foreign_landing_url: z.string().nullish(),
  license: z.string(),
  license_version: z.string().nullish(),
  license_url: z.string().nullish(),
  source: z.string().nullish(),
  attribution: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});
const OvResponse = z.object({ results: z.array(OvResult).nullish() });

function aspectRatio(orientation: string): string {
  return orientation === 'portrait' ? 'tall' : orientation === 'square' ? 'square' : 'wide';
}

export class OpenverseProvider implements MediaProvider {
  readonly id = 'openverse' as const;

  async search(query: SearchQuery): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // Openverse has no video

    const url = new URL(OV_BASE);
    url.searchParams.set('q', query.query);
    url.searchParams.set('license', 'cc0,pdm,by'); // no-strike allow set (doc 23)
    url.searchParams.set('license_type', 'commercial,modification');
    url.searchParams.set('aspect_ratio', aspectRatio(query.orientation));
    url.searchParams.set('page_size', String(query.perPage));
    url.searchParams.set('mature', 'false');

    const res = await fetch(url, {
      headers: { 'user-agent': 'ScriptReel/1.0 (local script-to-video; free CC media)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`openverse /images → HTTP ${res.status}`);
    const parsed = OvResponse.parse(await res.json());

    const out: RawCandidate[] = [];
    for (const r of parsed.results ?? []) {
      const download = r.url;
      const thumb = r.thumbnail ?? r.url;
      if (!download || !thumb) continue;
      out.push({
        provider: 'openverse',
        providerId: r.id,
        kind: 'image',
        width: r.width ?? 0,
        height: r.height ?? 0,
        thumbUrl: thumb,
        downloadUrl: download,
        pageUrl: r.foreign_landing_url ?? download,
        author: r.creator ?? 'Unknown',
        // A classifiable license (classifyLicense handles code or URL); the ready
        // attribution string + source ride along in meta for the credits builder.
        license: r.license_url ?? `CC ${r.license.toUpperCase()} ${r.license_version ?? ''}`.trim(),
        meta: {
          source: r.source ?? 'openverse',
          licenseCode: r.license,
          ...(r.license_version ? { licenseVersion: r.license_version } : {}),
          ...(r.attribution ? { attribution: r.attribution } : {}),
        },
      });
    }
    return out;
  }
}
