import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// Wikimedia Commons (doc 23): the universal named-subject archive — people, places,
// events, works — under a mix of PD/CC0/CC-BY/CC-BY-SA. Image-only. Keyless (a
// descriptive User-Agent is all Commons asks for). The search-stage license gate
// drops ShareAlike/NC/ND defensively, so only strike-safe items survive.
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

// We ask for a bounded, pre-scaled render (iiurlwidth) so we never download a 50 MP
// original; 1920 px is ample for 1080p/1920p output with room for a Ken Burns zoom.
const RENDER_WIDTH = 1920;

const ExtField = z.object({ value: z.string() }).nullish();
const ImageInfo = z.object({
  url: z.string().nullish(), // full-resolution original
  thumburl: z.string().nullish(), // pre-scaled render at iiurlwidth
  thumbwidth: z.number().nullish(),
  thumbheight: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  mime: z.string().nullish(),
  descriptionurl: z.string().nullish(), // the Commons file page
  extmetadata: z
    .object({
      License: ExtField,
      LicenseShortName: ExtField,
      LicenseUrl: ExtField,
      Artist: ExtField,
      Attribution: ExtField,
      Credit: ExtField,
    })
    .nullish(),
});
const Page = z.object({
  pageid: z.number().nullish(),
  title: z.string().nullish(),
  imageinfo: z.array(ImageInfo).nullish(),
});
// formatversion=2 → query.pages is an array (not a pageid-keyed object).
const CommonsResponse = z.object({
  query: z.object({ pages: z.array(Page).nullish() }).nullish(),
});

// extmetadata values are HTML fragments (e.g. `<a href="…">Jane Doe</a>`). Reduce to
// plain text: strip tags, collapse whitespace, decode the handful of common entities.
function plainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function value(field: { value: string } | null | undefined): string | undefined {
  const v = field?.value?.trim();
  return v ? v : undefined;
}

export class WikimediaProvider implements MediaProvider {
  readonly id = 'wikimedia' as const;

  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // image-only for now

    const url = new URL(COMMONS_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    url.searchParams.set('generator', 'search');
    // `filetype:bitmap` restricts to raster photos (skips SVG/PDF/audio/video).
    url.searchParams.set('gsrsearch', `${query.query} filetype:bitmap`);
    url.searchParams.set('gsrnamespace', '6'); // File: namespace
    url.searchParams.set('gsrlimit', String(query.perPage));
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
    url.searchParams.set('iiurlwidth', String(RENDER_WIDTH));
    url.searchParams.set(
      'iiextmetadatafilter',
      'License|LicenseShortName|LicenseUrl|Artist|Attribution|Credit',
    );

    const res = await fetch(url, {
      headers: { 'user-agent': 'ScriptReel/1.0 (local script-to-video; free CC/PD media)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`wikimedia /api → HTTP ${res.status}`);
    const parsed = CommonsResponse.parse(await res.json());

    const out: RawCandidate[] = [];
    for (const page of parsed.query?.pages ?? []) {
      const ii = (page.imageinfo ?? [])[0];
      if (!ii?.mime?.startsWith('image/') || ii.mime === 'image/tiff') continue;
      const download = ii.thumburl ?? ii.url;
      if (!download) continue;
      const meta = ii.extmetadata ?? {};
      // Feed the gate every license signal at once. Commons reports a bare code
      // ("pd", "cc0", "cc-by-sa-4.0"), a human name ("Public domain"), and often a
      // URL — no single field is always classifiable (e.g. bare "pd" isn't). Combining
      // maximizes recall; classifyLicense checks NC/ND/SA before BY, so a restrictive
      // form still wins over an allow. Empty → unstated → rejected downstream.
      const license = [value(meta.LicenseShortName), value(meta.License), value(meta.LicenseUrl)]
        .filter(Boolean)
        .join(' ');
      const attribution = plainText(value(meta.Attribution) ?? value(meta.Credit));
      out.push({
        provider: 'wikimedia',
        providerId: String(page.pageid ?? page.title ?? download),
        kind: 'image',
        // Report the delivered (scaled) geometry so hygiene/aspect match the asset.
        width: ii.thumbwidth ?? ii.width ?? 0,
        height: ii.thumbheight ?? ii.height ?? 0,
        thumbUrl: download,
        downloadUrl: download,
        pageUrl: ii.descriptionurl ?? download,
        author: plainText(value(meta.Artist)) || 'Wikimedia Commons',
        license,
        meta: {
          source: 'wikimedia commons',
          ...(value(meta.LicenseShortName)
            ? { licenseShortName: value(meta.LicenseShortName) }
            : {}),
          ...(attribution ? { attribution } : {}),
          ...(page.title ? { title: page.title } : {}),
        },
      });
    }
    return out;
  }
}
