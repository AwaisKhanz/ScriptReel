import type { MediaProvider, RawCandidate, RequestAuth, SearchQuery } from '@scriptreel/core';
import { z } from 'zod';

// Wikimedia Commons (doc 23 / doc 24): the universal named-subject archive — people,
// places, events, works — under a mix of PD/CC0/CC-BY/CC-BY-SA. Image-only. Keyless (a
// descriptive User-Agent is all Commons asks for). The search-stage license gate drops
// ShareAlike/NC/ND defensively, so only strike-safe items survive.
//
// Host choice is load-bearing: `commons.wikimedia.org` is TLS-unreachable from some
// networks (ECONNRESET — confirmed here and in the doc 24 research), so we split the work
// across two hosts that ARE reachable, exactly like the wikidata-commons resolver:
//   1. api.wikimedia.org — Commons full-text search → File: titles
//   2. en.wikipedia.org  — cross-wiki imageinfo     → url + license (extmetadata)
const COMMONS_SEARCH = 'https://api.wikimedia.org/core/v1/commons/search/page';
const IMAGEINFO_API = 'https://en.wikipedia.org/w/api.php';
const UA = 'ScriptReel/1.0 (local script-to-video; free CC/PD media)';
const HTTP_TIMEOUT_MS = 12_000;

// We ask for a bounded, pre-scaled render (iiurlwidth) so we never download a 50 MP
// original; 1920 px is ample for 1080p/1920p output with room for a Ken Burns zoom.
const RENDER_WIDTH = 1920;

// ── Step 1: Commons full-text search → File: titles (reachable host) ──
const SearchResponse = z.object({
  pages: z.array(z.object({ key: z.string().nullish(), title: z.string().nullish() })).nullish(),
});

// ── Step 2: cross-wiki imageinfo → url + license ──
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

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'api-user-agent': UA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

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

  // `_auth` unused: anonymous access is sufficient and the keyed OAuth path lived on the
  // unreachable commons.wikimedia.org host (doc 24 §4). QuotaGuard still meters requests.
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'video') return []; // image-only for now

    // Step 1: full-text Commons search on a reachable host → File: titles only.
    const searchUrl = new URL(COMMONS_SEARCH);
    searchUrl.searchParams.set('q', query.query);
    searchUrl.searchParams.set('limit', String(query.perPage));
    const searchParsed = SearchResponse.safeParse(await getJson(searchUrl));
    const titles = (searchParsed.success ? (searchParsed.data.pages ?? []) : [])
      .map((p) => p.title ?? '')
      .filter((t) => t.startsWith('File:')) // gallery/category pages carry no imageinfo
      .slice(0, query.perPage);
    if (titles.length === 0) return [];

    // Step 2: one cross-wiki imageinfo call → url + license for every title.
    const infoUrl = new URL(IMAGEINFO_API);
    infoUrl.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      titles: titles.join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: String(RENDER_WIDTH),
      iiextmetadatafilter: 'License|LicenseShortName|LicenseUrl|Artist|Attribution|Credit',
    }).toString();
    const parsed = CommonsResponse.parse(await getJson(infoUrl));

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
