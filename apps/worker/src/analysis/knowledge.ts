import { INSTANCE_OF_QID } from '@scriptreel/core';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  type Claims,
  claimEntityIds,
  claimStrings,
  fetchCommonsFiles,
  getClaims,
  searchEntities,
} from '../providers/wikidata-commons';

// Knowledge expansion (doc 25 §2a): before searching, deepen what we know about a
// visualizable entity — aliases + related entities (extra query terms), dates (→ derived
// era), and a Wikipedia summary (2–3 more visual terms). Worker-side I/O; keyless;
// Wikimedia wants a descriptive User-Agent. Every failure degrades to empty (the search
// stage still has the LLM's own terms — invariant 7).

const UA = 'ScriptReel/1.0 (local script-to-video generator)';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const HTTP_TIMEOUT_MS = 12_000;

const MAX_ENTITY_CANDIDATES = 3; // wbsearch hits to P31-check before giving up
const MAX_ALIASES = 4;
const MAX_RELATED = 5;
const MAX_EXTRA_TERMS = 3;
const HISTORICAL_CUTOFF_YEAR = 1900; // earliest relevant date before this ⇒ historical

// Date-bearing claim properties: inception, birth, death, start, point-in-time.
const DATE_PROPS = ['P571', 'P569', 'P570', 'P580', 'P585'] as const;
// Related-entity properties whose labels make good extra search terms (country, capital,
// admin territory, creator, location, country-of-origin).
const RELATED_PROPS = ['P17', 'P36', 'P131', 'P170', 'P276', 'P495'] as const;

export interface EntityKnowledge {
  qid: string | null;
  aliases: string[];
  relatedTerms: string[];
  era: 'modern' | 'historical' | null; // derived from dates; null ⇒ undated / unknown
  extraTerms: string[]; // from the Wikipedia summary
}

const EMPTY: EntityKnowledge = {
  qid: null,
  aliases: [],
  relatedTerms: [],
  era: null,
  extraTerms: [],
};

async function getJson(url: URL, retries = 2): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'api-user-agent': UA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  // Wikidata rate-limits bursts (429) — knowledge expansion fires several calls per entity, so
  // back off (honoring Retry-After) and retry before giving up. Only then does expansion degrade
  // to the LLM's own search terms (invariant 7). Mirrors providers/wikidata-commons.ts.
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (3 - retries);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return getJson(url, retries - 1);
  }
  if (!res.ok) throw new Error(`${url.host} → HTTP ${res.status}`);
  return res.json();
}

// ── Pure: derive era from a Wikidata entity's dated claims ──
// Earliest 4-digit (or BCE) year across the date props; < cutoff ⇒ historical, else modern.
export function eraFromClaims(claims: Claims): 'modern' | 'historical' | null {
  const years: number[] = [];
  for (const p of DATE_PROPS) {
    for (const c of claims[p] ?? []) {
      const value = c.mainsnak?.datavalue?.value;
      const time =
        value && typeof value === 'object' && 'time' in value
          ? (value as { time?: unknown }).time
          : undefined;
      if (typeof time !== 'string') continue;
      // Wikidata time: "+1856-07-10T00:00:00Z" | "-0044-03-15T00:00:00Z".
      const m = /^([+-]\d+)-\d{2}-\d{2}/.exec(time);
      const year = m ? Number(m[1]) : Number.NaN;
      if (Number.isFinite(year)) years.push(year);
    }
  }
  if (years.length === 0) return null;
  return Math.min(...years) < HISTORICAL_CUTOFF_YEAR ? 'historical' : 'modern';
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'its',
  'their',
  'from',
  'into',
  'near',
  'also',
  'known',
  'located',
  'which',
  'between',
  'within',
  'about',
  'over',
  'under',
  'called',
  'named',
  'other',
  'more',
  'most',
  'such',
  'one',
  'two',
  'often',
  'used',
  'being',
  'been',
  'they',
  'them',
]);

// ── Pure: pull up to N significant terms from a Wikipedia summary's lead sentence ──
// Skips stopwords and the entity's own name words; rough but the search gates filter noise.
export function extractTerms(extract: string, exclude: readonly string[]): string[] {
  const lead = extract.split(/(?<=[.!?])\s/)[0] ?? extract;
  const excl = new Set<string>([
    ...STOPWORDS,
    ...exclude.flatMap((e) => e.toLowerCase().split(/\s+/).filter(Boolean)),
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lead
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)) {
    if (raw.length <= 3 || excl.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_EXTRA_TERMS) break;
  }
  return out;
}

// ── wbgetentities: aliases + enwiki sitelink title (for the entity) + labels (for related) ──
const WbEntities = z.object({
  entities: z
    .record(
      z.string(),
      z.object({
        labels: z.record(z.string(), z.object({ value: z.string() })).nullish(),
        aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).nullish(),
        sitelinks: z.record(z.string(), z.object({ title: z.string() })).nullish(),
      }),
    )
    .nullish(),
});

async function fetchMeta(
  qid: string,
  relatedQids: readonly string[],
): Promise<{ aliases: string[]; enTitle: string | null; relatedTerms: string[] }> {
  const ids = [qid, ...relatedQids.slice(0, MAX_RELATED)];
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels|aliases|sitelinks',
    languages: 'en',
    sitefilter: 'enwiki',
    format: 'json',
  }).toString();
  const parsed = WbEntities.safeParse(await getJson(url));
  if (!parsed.success) return { aliases: [], enTitle: null, relatedTerms: [] };
  const ents = parsed.data.entities ?? {};
  const self = ents[qid];
  const aliases = (self?.aliases?.en ?? []).map((a) => a.value).slice(0, MAX_ALIASES);
  const enTitle = self?.sitelinks?.enwiki?.title ?? null;
  const relatedTerms: string[] = [];
  for (const rq of relatedQids.slice(0, MAX_RELATED)) {
    const label = ents[rq]?.labels?.en?.value;
    if (label) relatedTerms.push(label);
  }
  return { aliases, enTitle, relatedTerms };
}

const Summary = z.object({ extract: z.string().nullish() });

async function wikipediaTerms(title: string, exclude: readonly string[]): Promise<string[]> {
  const url = new URL(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  );
  const parsed = Summary.safeParse(await getJson(url));
  const extract = parsed.success ? (parsed.data.extract ?? '') : '';
  return extractTerms(extract, exclude);
}

// Resolve the entity's Q-id, verifying sense via P31 (doc 24 §4) — same rule as the
// resolver so the two agree on which entity we mean.
export async function resolveVerifiedClaims(
  canonical: string,
  instanceOf: string,
): Promise<{ qid: string; claims: Claims } | null> {
  const qids = await searchEntities(canonical);
  if (qids.length === 0) return null;
  const expected = INSTANCE_OF_QID[instanceOf.toLowerCase()] ?? '';
  let first: { qid: string; claims: Claims } | null = null;
  for (const qid of qids.slice(0, MAX_ENTITY_CANDIDATES)) {
    const claims = await getClaims(qid);
    if (!first) first = { qid, claims };
    if (!expected || claimEntityIds(claims, 'P31').includes(expected)) return { qid, claims };
  }
  return first; // lenient: unmapped instanceOf accepts the top hit (like the resolver)
}

// Resolve a named entity to a reachable REFERENCE-IMAGE url (doc 25 §5-C) for the
// identity gate: the entity's Wikidata P18 (image), falling back to P154 (logo) then
// P242 (locator map). The filename is rasterized through Commons imageinfo to a
// downloadable en.wikipedia.org thumbnail (commons.wikimedia.org is TLS-unreachable —
// fetchCommonsFiles already picks the right host). Any failure → null; NEVER throws, so
// an absent reference never breaks selection (invariant 7). The identity pass compares a
// beat's candidate thumbs to this image with InsightFace (person) / DINOv2 (landmark).
export async function resolveReferenceImage(
  canonical: string,
  instanceOf: string,
): Promise<string | null> {
  try {
    const resolved = await resolveVerifiedClaims(canonical, instanceOf);
    if (!resolved) return null;
    const filename =
      claimStrings(resolved.claims, 'P18')[0] ??
      claimStrings(resolved.claims, 'P154')[0] ??
      claimStrings(resolved.claims, 'P242')[0];
    if (!filename) return null;
    const files = await fetchCommonsFiles([filename]);
    return files[0]?.url ?? null;
  } catch {
    return null; // no reference is fine — the gate simply skips this beat
  }
}

// Expand one entity. Returns EMPTY on any failure (invariant 7). The caller memoizes by
// canonical name so a repeated entity across beats is fetched once.
export async function expandEntity(
  canonical: string,
  instanceOf: string,
  log: Logger,
): Promise<EntityKnowledge> {
  try {
    const resolved = await resolveVerifiedClaims(canonical, instanceOf);
    if (!resolved) return EMPTY;
    const { qid, claims } = resolved;
    const era = eraFromClaims(claims);
    const relatedQids = [...new Set(RELATED_PROPS.flatMap((p) => claimEntityIds(claims, p)))];
    const { aliases, enTitle, relatedTerms } = await fetchMeta(qid, relatedQids);
    const extraTerms = enTitle
      ? await wikipediaTerms(enTitle, [canonical, ...aliases]).catch(() => [])
      : [];
    return { qid, aliases, relatedTerms, era, extraTerms };
  } catch (err) {
    log.warn({ err, canonical }, 'knowledge expansion failed — using LLM terms only');
    return EMPTY;
  }
}
