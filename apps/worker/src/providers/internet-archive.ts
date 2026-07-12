import {
  isLicenseAllowed,
  type MediaProvider,
  type RawCandidate,
  type RequestAuth,
  type SearchQuery,
} from '@scriptreel/core';
import pLimit from 'p-limit';
import { z } from 'zod';

// Internet Archive (doc 25 §2): keyless PD/CC archival VIDEO footage — the first video
// archive. A Solr advancedsearch returns identifiers + license urls; each item's real file
// list is a second /metadata call, so we cap the list and bound the fan-out. Every failure
// degrades to [] (the search stage then falls back to stock — invariant 7). IA asks for a
// descriptive User-Agent.
const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const IA_METADATA = 'https://archive.org/metadata';
const IA_DOWNLOAD = 'https://archive.org/download';
const IA_DETAILS = 'https://archive.org/details';
const IA_THUMB = 'https://archive.org/services/img';
const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const HTTP_TIMEOUT_MS = 12_000;
const MAX_ITEMS = 4; // license-allowed docs to resolve per search — bounds the second-call fan-out
const ITEM_PARALLELISM = 4;
const MAX_BYTES = 300_000_000; // skip the giant original — cap the download at ~300 MB
const MIN_BYTES = 200_000; // skip degenerate/placeholder clips (~200 KB floor)
const DURATION_FALLBACK_SEC = 60; // unparseable length → a value that clears hygiene (≥ 2 s)

// IA fields can arrive as a scalar or a single-element array; normalize to the first string.
function firstString(v: string | readonly string[] | null | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === 'string') ?? '';
  return '';
}

const IaSearchDoc = z.object({
  identifier: z.string(),
  title: z.union([z.string(), z.array(z.string())]).nullish(),
  licenseurl: z.string().nullish(),
  year: z.union([z.string(), z.number()]).nullish(),
});
type IaSearchDoc = z.infer<typeof IaSearchDoc>;
const IaSearchResponse = z.object({
  response: z.object({ docs: z.array(IaSearchDoc).nullish() }).nullish(),
});

const IaFile = z.object({
  name: z.string(),
  format: z.string().nullish(),
  size: z.string().nullish(), // stringified bytes
  length: z.string().nullish(), // float-seconds "213.4" or "MM:SS" / "H:MM:SS"
});
export type IaFile = z.infer<typeof IaFile>;
const IaMetadata = z.object({
  metadata: z
    .object({
      creator: z.union([z.string(), z.array(z.string())]).nullish(),
      title: z.union([z.string(), z.array(z.string())]).nullish(),
    })
    .nullish(),
  files: z.array(IaFile).nullish(),
});

function parseBytes(size: string | null | undefined): number {
  if (size == null || size.trim() === '') return Number.NaN;
  const n = Number(size);
  return Number.isFinite(n) ? n : Number.NaN;
}

// Pure: choose a usable .mp4 to download. Prefer the smallest .mp4 within [MIN_BYTES,
// MAX_BYTES] (avoids the giant original and degenerate placeholders); if none is in range,
// fall back to the smallest .mp4 regardless of size. Null when there is no .mp4 at all.
export function pickVideoFile(files: readonly IaFile[]): IaFile | null {
  const mp4s = files.filter((f) => f.name.toLowerCase().endsWith('.mp4'));
  if (mp4s.length === 0) return null;
  const sized = mp4s.map((file) => ({ file, bytes: parseBytes(file.size) }));
  const inRange = sized.filter(
    (s) => Number.isFinite(s.bytes) && s.bytes >= MIN_BYTES && s.bytes <= MAX_BYTES,
  );
  const pool = inRange.length > 0 ? inRange : sized;
  // Smallest first; unknown size sorts last so real sizes win, first .mp4 if all unknown.
  let best = pool[0];
  if (!best) return null;
  for (const s of pool) {
    const a = Number.isFinite(s.bytes) ? s.bytes : Number.POSITIVE_INFINITY;
    const b = Number.isFinite(best.bytes) ? best.bytes : Number.POSITIVE_INFINITY;
    if (a < b) best = s;
  }
  return best.file;
}

// Pure: IA `length` → seconds. "213.4" → 213.4; "MM:SS"/"H:MM:SS" → total seconds;
// missing/garbage → DURATION_FALLBACK_SEC so video hygiene (duration ≥ 2) still passes.
export function parseDurationSec(length: string | null | undefined): number {
  if (length == null) return DURATION_FALLBACK_SEC;
  const s = length.trim();
  if (s === '') return DURATION_FALLBACK_SEC;
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return DURATION_FALLBACK_SEC;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : DURATION_FALLBACK_SEC;
}

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

function buildSearchUrl(query: string, rows: number): URL {
  const url = new URL(IA_SEARCH);
  url.searchParams.set('q', `${query} AND mediatype:movies`);
  url.searchParams.append('fl[]', 'identifier');
  url.searchParams.append('fl[]', 'title');
  url.searchParams.append('fl[]', 'licenseurl');
  url.searchParams.append('fl[]', 'year');
  url.searchParams.append('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('output', 'json');
  return url;
}

async function resolveItem(doc: IaSearchDoc): Promise<RawCandidate | null> {
  try {
    const parsed = IaMetadata.safeParse(await getJson(new URL(`${IA_METADATA}/${doc.identifier}`)));
    if (!parsed.success) return null;
    const file = pickVideoFile(parsed.data.files ?? []);
    if (!file) return null;
    const meta = parsed.data.metadata;
    return {
      provider: 'internet-archive',
      providerId: doc.identifier,
      kind: 'video',
      width: 0, // unknown until download; hygiene keeps unknown-geometry candidates
      height: 0,
      duration: parseDurationSec(file.length),
      thumbUrl: `${IA_THUMB}/${doc.identifier}`,
      downloadUrl: `${IA_DOWNLOAD}/${doc.identifier}/${encodeURIComponent(file.name)}`,
      pageUrl: `${IA_DETAILS}/${doc.identifier}`,
      author: firstString(meta?.creator) || 'Internet Archive',
      license: doc.licenseurl ?? '', // the doc's licenseurl (passed the gate) — round-trips it
      meta: {
        source: 'internet archive',
        title: firstString(meta?.title) || firstString(doc.title),
      },
    };
  } catch {
    return null; // one item's metadata 404/timeout must not drop the rest of the batch
  }
}

export class InternetArchiveProvider implements MediaProvider {
  readonly id = 'internet-archive' as const;

  // `_auth` is keyless (kept for the MediaProvider contract): the Internet Archive
  // advancedsearch/metadata APIs take no key.
  async search(query: SearchQuery, _auth: RequestAuth): Promise<RawCandidate[]> {
    if (query.kind === 'image') return []; // Internet Archive is video-only here

    const parsed = IaSearchResponse.safeParse(
      await getJson(buildSearchUrl(query.query, query.perPage)),
    );
    if (!parsed.success) return [];

    // Keep only license-allowed docs (PD/CC0/CC-BY; a missing licenseurl = reject), then cap.
    const docs = (parsed.data.response?.docs ?? [])
      .filter((d) => isLicenseAllowed(d.licenseurl))
      .slice(0, MAX_ITEMS);
    if (docs.length === 0) return [];

    const limit = pLimit(ITEM_PARALLELISM);
    const resolved = await Promise.all(docs.map((doc) => limit(() => resolveItem(doc))));
    return resolved.filter((c): c is RawCandidate => c !== null);
  }
}
