import {
  type Entity,
  type EntityCategory,
  EntitySchema,
  type Shot,
  ShotSchema,
  type ShotWant,
} from './analysis';
import type { ProviderId } from './providers';

// Entity → authoritative-source routing (doc 24 §4–5). Pure data + parsers; the worker's
// resolver and search stage consume these. No I/O here (invariant 8).

// Categories that name a SPECIFIC subject (doc 23 §6.3 / doc 24) — a generic stand-in
// would be wrong for these, so they trigger the stricter media cross-check and the
// authoritative path. Broad/mood categories (concept, object, nature, animal, symbol,
// flag) stay on generic stock + SigLIP.
export const NAMED_SUBJECT_CATEGORIES: ReadonlySet<EntityCategory> = new Set<EntityCategory>([
  'person',
  'country',
  'region',
  'city',
  'landmark',
  'lake',
  'ocean',
  'mountain',
  'river',
  'planet',
  'astro',
  'building',
  'vehicle',
  'company',
  'brand',
  'product',
  'software',
  'artwork',
  'book',
  'film',
  'event',
]);

// A beat "names a specific subject" when it has a visualizable entity in a specific
// category — the cases where a generic stand-in would be wrong (doc 23 §6.3).
export function namesSubject(entities: readonly Entity[]): boolean {
  return entities.some(
    (e) => e.visualizable && e.canonical.length > 0 && NAMED_SUBJECT_CATEGORIES.has(e.category),
  );
}

// Defensive parsers for the jsonb columns (unknown until parsed — invariant 9). A row
// written before the entity upgrade, or any malformed item, simply drops to [].
export function parseEntities(raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  const out: Entity[] = [];
  for (const item of raw) {
    const parsed = EntitySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseShots(raw: unknown): Shot[] {
  if (!Array.isArray(raw)) return [];
  const out: Shot[] = [];
  for (const item of raw) {
    const parsed = ShotSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ── Authoritative-source routing (doc 24 §4–5) ────────────────────────────

// Wikidata image-bearing Commons-media properties, in priority order, by the shot's
// `want`. The resolver tries each until it finds a license-clean file. `footage` and
// `generic` have no still property — they come from NASA / Internet Archive / stock.
export const WANT_TO_PROPERTY: Readonly<Record<ShotWant, readonly string[]>> = {
  portrait: ['P18'],
  scene: ['P18', 'P948'],
  aerial: ['P8592', 'P948', 'P18'],
  flag: ['P41'],
  map: ['P242'], // locator map only — a coat of arms (P94) is not a map, so fall back to stock
  logo: ['P154', 'P18'],
  footage: [],
  generic: [],
};

// Wikidata "instance of" (P31) target ids by the lowercase class the LLM emits in
// `entity.instanceOf` — used to VERIFY that a name→Q-id link is the right SENSE (doc 24
// §4). LENIENT: an unmapped class skips verification (accept the top candidate) rather
// than blocking, and a wrong id here would only wrongly reject — so keep it conservative.
// [CALIBRATE] extend as real scripts surface new classes.
export const INSTANCE_OF_QID: Readonly<Record<string, string>> = {
  human: 'Q5',
  person: 'Q5',
  country: 'Q6256',
  'sovereign state': 'Q3624078',
  state: 'Q7275',
  region: 'Q82794',
  city: 'Q515',
  town: 'Q3957',
  lake: 'Q23397',
  sea: 'Q165',
  ocean: 'Q9430',
  mountain: 'Q8502',
  river: 'Q4022',
  island: 'Q23442',
  desert: 'Q8514',
  planet: 'Q634',
  'dwarf planet': 'Q3419',
  star: 'Q523',
  galaxy: 'Q318',
  business: 'Q4830453',
  enterprise: 'Q6881511',
  company: 'Q783794',
  software: 'Q7397',
  'programming language': 'Q9143',
  'video game': 'Q7889',
  brand: 'Q431289',
  product: 'Q2424752',
  building: 'Q41176',
  bridge: 'Q12280',
  animal: 'Q729',
  taxon: 'Q16521',
  artwork: 'Q838948',
  painting: 'Q3305213',
  book: 'Q571',
  'literary work': 'Q7725634',
  film: 'Q11424',
  vehicle: 'Q42889',
  event: 'Q1656682',
  war: 'Q198',
};

// Category → ordered authoritative providers (doc 24 §5). Empty ⇒ no authoritative
// source (concept/object) → generic stock + SigLIP. The search stage always adds a stock
// fallback on top, so a resolver miss never leaves a shot empty (degrade-never-die).
export const CATEGORY_SOURCES: Readonly<Record<EntityCategory, readonly ProviderId[]>> = {
  person: ['wikidata-commons'],
  country: ['wikidata-commons'],
  region: ['wikidata-commons'],
  city: ['wikidata-commons'],
  landmark: ['wikidata-commons'],
  lake: ['wikidata-commons'],
  ocean: ['wikidata-commons'],
  mountain: ['wikidata-commons'],
  river: ['wikidata-commons'],
  nature: ['wikidata-commons'],
  animal: ['wikidata-commons'],
  planet: ['nasa', 'wikidata-commons'],
  astro: ['nasa', 'wikidata-commons'],
  building: ['wikidata-commons'],
  vehicle: ['wikidata-commons'],
  company: ['wikidata-commons'],
  brand: ['wikidata-commons'],
  product: ['wikidata-commons'],
  software: ['wikidata-commons'],
  artwork: ['wikidata-commons'],
  book: ['wikidata-commons'],
  film: ['wikidata-commons'],
  event: ['wikidata-commons'],
  concept: [],
  object: [],
  symbol: ['wikidata-commons'],
  flag: ['wikidata-commons'],
};

// Fallback `want` when the LLM leaves a shot generic but its entity's category has a
// natural default (doc 24 §5): a country → its map, a person → a portrait, etc.
export const CATEGORY_DEFAULT_WANT: Readonly<Record<EntityCategory, ShotWant>> = {
  person: 'portrait',
  country: 'map',
  region: 'map',
  city: 'scene',
  landmark: 'scene',
  lake: 'aerial',
  ocean: 'aerial',
  mountain: 'scene',
  river: 'aerial',
  nature: 'scene',
  animal: 'scene',
  planet: 'scene',
  astro: 'scene',
  building: 'scene',
  vehicle: 'scene',
  company: 'logo',
  brand: 'logo',
  product: 'scene',
  software: 'logo',
  artwork: 'scene',
  book: 'scene',
  film: 'scene',
  event: 'footage',
  concept: 'generic',
  object: 'scene',
  symbol: 'scene',
  flag: 'flag',
};
