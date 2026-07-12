import {
  INSTANCE_OF_QID,
  isLicenseAllowed,
  type MediaProvider,
  type RawCandidate,
  type RequestAuth,
  type SearchQuery,
  type ShotWant,
  WANT_TO_PROPERTY,
} from '@scriptreel/core';
import { z } from 'zod';

// Authoritative entity resolver (doc 24 §4): a name → the REAL Commons image, verified by
// sense (P31) and license-gated. Keyless; Wikimedia requires a descriptive User-Agent.
// Every failure degrades to [] (the search stage then falls back to stock — invariant 7).
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// Commons files are the shared media repo, so ANY MediaWiki host resolves them via
// imageinfo. We use en.wikipedia.org because commons.wikimedia.org's TLS is unreliable
// from some networks (doc 24 §4 research) — same url + extmetadata license in one call.
const COMMONS_API = 'https://en.wikipedia.org/w/api.php';
const HTTP_TIMEOUT_MS = 12_000;
const MAX_ENTITY_CANDIDATES = 3; // how many wbsearch hits to P31-check before giving up
const MAX_FILES = 4; // Commons files to resolve per shot
const RENDER_WIDTH = 1600; // we download a rasterized thumbnail at this width — handles SVG
//                            flags/maps and caps huge originals in one move.

async function getJson(url: URL, retries = 1): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'api-user-agent': UA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  // Wikimedia rate-limits bursts (429) — back off once (honoring Retry-After) before
  // giving up, so a busy moment falls back to stock only when it truly must (invariant 7).
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1200;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return getJson(url, retries - 1);
  }
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

// ── Step 1: name → Q-id candidates (fuzzy/alias-aware) ──
const WbSearch = z.object({
  search: z.array(z.object({ id: z.string() })).nullish(),
});
async function searchEntities(name: string): Promise<string[]> {
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    uselang: 'en',
    type: 'item',
    format: 'json',
    limit: '5',
  }).toString();
  const parsed = WbSearch.safeParse(await getJson(url));
  if (!parsed.success) return [];
  return (parsed.data.search ?? []).map((s) => s.id);
}

// ── Step 2: Q-id → claims (all properties in one call) ──
type Claim = { mainsnak?: { datavalue?: { value?: unknown } }; rank?: string };
export type Claims = Record<string, Claim[]>;
const WbClaims = z.object({ claims: z.record(z.string(), z.array(z.any())).nullish() });
async function getClaims(qid: string): Promise<Claims> {
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({
    action: 'wbgetclaims',
    entity: qid,
    format: 'json',
  }).toString();
  const parsed = WbClaims.safeParse(await getJson(url));
  return ((parsed.success ? parsed.data.claims : null) ?? {}) as Claims;
}

// Pure: string-valued claims (Commons filenames) for a property, preferred-rank first.
export function claimStrings(claims: Claims, property: string): string[] {
  const arr = claims[property] ?? [];
  const ranked = [...arr].sort(
    (a, b) => (b.rank === 'preferred' ? 1 : 0) - (a.rank === 'preferred' ? 1 : 0),
  );
  const out: string[] = [];
  for (const c of ranked) {
    const v = c.mainsnak?.datavalue?.value;
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

// Pure: entity-id-valued claims (e.g. P31 instance-of → ['Q23397', …]).
export function claimEntityIds(claims: Claims, property: string): string[] {
  const arr = claims[property] ?? [];
  const out: string[] = [];
  for (const c of arr) {
    const v = c.mainsnak?.datavalue?.value;
    if (v && typeof v === 'object' && 'id' in v) {
      const id = (v as { id?: unknown }).id;
      if (typeof id === 'string') out.push(id);
    }
  }
  return out;
}

// Pure: Commons filenames to try for a `want`, in property priority order, deduped/capped.
export function filenamesForWant(claims: Claims, want: ShotWant): string[] {
  const props = WANT_TO_PROPERTY[want] ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of props) {
    for (const f of claimStrings(claims, p)) {
      const key = f.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(f);
      }
    }
  }
  return out.slice(0, MAX_FILES);
}

// ── Step 3: Commons filenames → downloadable url + license (one imageinfo call) ──
const InfoItem = z.object({
  url: z.string().nullish(),
  thumburl: z.string().nullish(),
  thumbwidth: z.number().nullish(),
  thumbheight: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  descriptionurl: z.string().nullish(),
  extmetadata: z.any().nullish(),
});
const ImageInfo = z.object({
  query: z
    .object({
      pages: z
        .record(
          z.string(),
          z.object({ title: z.string().nullish(), imageinfo: z.array(InfoItem).nullish() }),
        )
        .nullish(),
    })
    .nullish(),
});

interface CommonsFile {
  title: string;
  url: string; // rasterized thumbnail — safe to download (handles SVG + huge originals)
  width: number;
  height: number;
  pageUrl: string;
  license: string; // raw extmetadata code, e.g. 'cc-by-4.0' | 'cc0' | 'pd'
  author: string;
}

function extValue(extmeta: unknown, key: string): string {
  if (!extmeta || typeof extmeta !== 'object') return '';
  const entry = (extmeta as Record<string, unknown>)[key];
  if (!entry || typeof entry !== 'object') return '';
  const v = (entry as { value?: unknown }).value;
  return typeof v === 'string' ? v : '';
}
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchCommonsFiles(filenames: string[]): Promise<CommonsFile[]> {
  if (filenames.length === 0) return [];
  const url = new URL(COMMONS_API);
  url.search = new URLSearchParams({
    action: 'query',
    titles: filenames.map((f) => `File:${f}`).join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: String(RENDER_WIDTH),
    format: 'json',
  }).toString();
  const parsed = ImageInfo.safeParse(await getJson(url));
  if (!parsed.success) return [];
  const out: CommonsFile[] = [];
  for (const page of Object.values(parsed.data.query?.pages ?? {})) {
    const info = (page.imageinfo ?? [])[0];
    const download = info?.thumburl ?? info?.url;
    if (!info || !download) continue;
    const ext = info.extmetadata;
    out.push({
      title: page.title ?? download,
      url: download,
      width: info.thumbwidth ?? info.width ?? 0,
      height: info.thumbheight ?? info.height ?? 0,
      pageUrl: info.descriptionurl ?? '',
      license:
        extValue(ext, 'License') ||
        extValue(ext, 'LicenseShortName') ||
        extValue(ext, 'UsageTerms'),
      author: stripHtml(extValue(ext, 'Artist')) || 'Wikimedia Commons',
    });
  }
  return out;
}

export class WikidataCommonsProvider implements MediaProvider {
  readonly id = 'wikidata-commons' as const;

  // `_auth` is keyless (kept for the MediaProvider contract).
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    const ent = query.entity;
    if (!ent || query.kind !== 'image') return []; // resolver serves entity image requests only
    if ((WANT_TO_PROPERTY[ent.want] ?? []).length === 0) return []; // footage/generic → not here

    const qids = await searchEntities(ent.canonical);
    if (qids.length === 0) return [];

    // Verify the SENSE via P31 (doc 24 §4) — this is what stops "Jordan the person".
    // Lenient: an unmapped instanceOf accepts the top hit; a mismatch tries the next.
    const expected = INSTANCE_OF_QID[ent.instanceOf.toLowerCase()] ?? '';
    let chosen: Claims | null = null;
    let firstClaims: Claims | null = null;
    for (const qid of qids.slice(0, MAX_ENTITY_CANDIDATES)) {
      const claims = await getClaims(qid);
      if (!firstClaims) firstClaims = claims;
      if (!expected || claimEntityIds(claims, 'P31').includes(expected)) {
        chosen = claims;
        break;
      }
    }
    const use = chosen ?? firstClaims;
    if (!use) return [];

    const files = await fetchCommonsFiles(filenamesForWant(use, ent.want));
    const out: RawCandidate[] = [];
    for (const f of files) {
      if (!isLicenseAllowed(f.license)) continue; // owner gate: PD/CC0/CC-BY only (doc 24 §4)
      out.push({
        provider: 'wikidata-commons',
        providerId: f.title,
        kind: 'image',
        width: f.width,
        height: f.height,
        thumbUrl: f.url,
        downloadUrl: f.url,
        pageUrl: f.pageUrl,
        author: f.author,
        license: f.license, // raw code (e.g. 'cc-by-4.0' | 'cc0' | 'pd') — round-trips the gate
        meta: { want: ent.want, canonical: ent.canonical },
      });
    }
    return out;
  }
}
