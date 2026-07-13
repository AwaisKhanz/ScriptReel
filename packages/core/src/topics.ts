import type { Entity, EntityCategory, Era } from './analysis';
import type { ProviderId } from './providers';

// Unified topic routing (supersedes the old 8-domain `classifyDomain`). A beat's TOPIC is the
// axis that routes it to authoritative/specialized sources. Two things changed from the old
// design that leaked every beat back to generic stock:
//   1. Coverage — ~19 topics spanning what real scripts actually cover (food, medicine, weather,
//      ocean, engineering, transport, business, education, travel …), so specialized archives
//      fire for far more beats instead of falling off a keyword cliff into `generic` = stock-only.
//   2. One router — the topic is inferred from BOTH the beat text AND its typed entity categories
//      (the LLM already disambiguated them). The keyword classifier and the entity taxonomy used
//      to be two separate, non-communicating routers; here they feed one decision.
// Pure data + functions, no I/O (invariant 8). The worker classifies each beat then routes.

export type Topic =
  | 'space'
  | 'medicine'
  | 'ocean'
  | 'weather'
  | 'nature'
  | 'earth'
  | 'history'
  | 'art'
  | 'science'
  | 'engineering'
  | 'technology'
  | 'transport'
  | 'food'
  | 'urban'
  | 'people'
  | 'business'
  | 'education'
  | 'travel'
  | 'generic';

// Topic → ordered SPECIALIZED sources to query for that topic (best/most-authoritative first).
// The universal base plan (Pexels/Pixabay + Openverse) always runs on top of these — so a topic
// with no strong archive (food/business/technology) leans on stock, which is genuinely right
// there. Empty ⇒ stock only. Uses the providers already wired; Phase 3 slots new ones (medical
// Open-i, NOAA weather/ocean, ESA space, Rijksmuseum art) into the relevant rows — extensibility
// is just editing this table + the ProviderId union.
export const TOPIC_SOURCES: Readonly<Record<Topic, readonly ProviderId[]>> = {
  space: ['nasa', 'wikimedia'],
  medicine: ['wellcome', 'wikimedia'], // Wellcome = the medical/anatomy authority (Phase 3)
  ocean: ['usgs', 'inaturalist', 'wikimedia'], // + noaa (Phase 3)
  weather: ['nasa', 'usgs', 'wikimedia'], // + noaa (Phase 3)
  nature: ['inaturalist', 'usgs', 'wikimedia', 'flickr'],
  earth: ['usgs', 'nasa', 'wikimedia'],
  history: ['internet-archive', 'library-of-congress', 'europeana', 'met', 'wikimedia'],
  art: ['met', 'smithsonian', 'europeana', 'wikimedia'], // + rijksmuseum (Phase 3)
  science: ['wikimedia', 'smithsonian', 'usgs'],
  engineering: ['wikimedia', 'library-of-congress'],
  technology: ['wikimedia'],
  transport: ['wikimedia', 'flickr'],
  food: ['wikimedia'],
  urban: ['flickr', 'library-of-congress', 'wikimedia'],
  people: ['library-of-congress', 'flickr', 'wikimedia'],
  business: [],
  education: ['library-of-congress', 'wikimedia'],
  travel: ['flickr', 'wikimedia'],
  generic: [],
};

// A visualizable named entity's category is a strong topic signal when the keyword pass is
// inconclusive (e.g. "a plate of pasta" has no topic keyword, but the entity "pasta" is `object`
// → generic/stock, while "Saturn" is `planet` → space). Maps the 28 entity categories onto topics.
export const CATEGORY_TOPIC: Readonly<Record<EntityCategory, Topic>> = {
  person: 'people',
  country: 'travel',
  region: 'travel',
  city: 'urban',
  landmark: 'travel',
  lake: 'nature',
  ocean: 'ocean',
  mountain: 'earth',
  river: 'nature',
  nature: 'nature',
  animal: 'nature',
  planet: 'space',
  astro: 'space',
  building: 'urban',
  vehicle: 'transport',
  company: 'business',
  brand: 'business',
  product: 'business',
  software: 'technology',
  artwork: 'art',
  book: 'art',
  film: 'art',
  event: 'history',
  concept: 'generic',
  object: 'generic',
  symbol: 'generic',
  flag: 'generic',
};

// Keyword rules, ordered most-specific → most-generic; first match wins. Marine/weather beats
// route before the broad `nature` rule; `transport` before `urban` (a highway is transport, a
// skyline is urban); `history` before `art` (a Renaissance fresco is a history beat). [CALIBRATE]
// — extend as real scripts surface vocabulary; misclassification degrades gracefully (a wrong
// archive returns nothing and the stock base plan still serves the beat).
const RULES: readonly { topic: Topic; re: RegExp }[] = [
  {
    topic: 'space',
    re: /\b(space|outer\s?space|astronomy|astronomer|astronaut|cosmonaut|nasa|cosmos|cosmic|universe|galaxy|galaxies|nebula|moon|lunar|mars|martian|jupiter|saturn|venus|mercury|neptune|uranus|pluto|planet|planetary|orbit|orbital|satellite|rocket|spacecraft|spaceship|space\s?station|apollo|voyager|hubble|telescope|comet|asteroid|meteor|solar\s?system|milky\s?way|supernova|black\s?hole|eclipse|constellation|stellar)\b/,
  },
  {
    topic: 'medicine',
    re: /\b(medicine|medical|medicinal|healthcare|health\s?care|hospital|clinic|clinical|doctor|physician|surgeon|surgery|surgical|nurse|patient|disease|illness|diagnosis|symptom|treatment|therapy|vaccine|vaccination|injection|cancer|tumou?r|x-?ray|mri|ultrasound|stethoscope|scalpel|prescription|pharmacy|pharmaceutical|anatomy|anatomical|organ|skeleton|skeletal|muscle|bone|artery|immune|dentist|dental|medication|ambulance|wheelchair)\b/,
  },
  {
    topic: 'ocean',
    re: /\b(ocean|oceanic|sea|marine|seabed|seafloor|coral|reef|kelp|plankton|whale|dolphin|shark|jellyfish|octopus|squid|seahorse|tide|tidal|underwater|deep\s?sea|scuba|diver|aquatic|seaweed|coastline|seashore)\b/,
  },
  {
    topic: 'weather',
    re: /\b(weather|climate|storm|thunderstorm|lightning|hurricane|typhoon|cyclone|tornado|blizzard|snowstorm|rainfall|monsoon|drought|flood|heatwave|forecast|meteorolog|atmospheric|precipitation)\b/,
  },
  {
    topic: 'nature',
    re: /\b(nature|wildlife|animal|bird|mammal|reptile|insect|butterfly|forest|jungle|rainforest|woodland|tree|trees|plant|plants|flower|botanical|botany|leaf|leaves|savann?a|meadow|wilderness|habitat|ecosystem|species|safari|elephant|lion|tiger|bear|wolf|deer|eagle)\b/,
  },
  {
    topic: 'earth',
    re: /\b(geology|geological|mineral|crystal|fossil|volcano|volcanic|lava|magma|earthquake|tectonic|canyon|glacier|iceberg|mountain|desert|terrain|sediment|erosion|landform|arctic|antarctic|tundra|environment|environmental|sustainab|renewable|pollution|ecolog)\b/,
  },
  {
    topic: 'history',
    re: /\b(history|historical|historic|ancient|antiquity|prehistoric|century|centuries|medieval|middle\s?ages|renaissance|empire|imperial|dynasty|pharaoh|pyramid|castle|fortress|knight|monarch|emperor|revolution|world\s?war|wwi|wwii|civilization|archaeolog|artifact|ruins|colonial|viking|samurai|founding\s?fathers)\b/,
  },
  {
    topic: 'art',
    re: /\b(artwork|painting|painter|sculpture|sculptor|museum|gallery|fresco|mural|portrait|masterpiece|exhibit|exhibition|canvas|drawing|pottery|ceramic|watercolou?r|oil\s?painting|baroque|impressionis|mosaic|tapestry|calligraphy)\b/,
  },
  {
    topic: 'science',
    re: /\b(science|scientific|biology|biological|chemistry|chemical|physics|cell|cellular|molecule|molecular|atom|atomic|dna|gene|genetic|genome|protein|neuron|microscope|laborator|experiment|reaction|bacteria|microbe|organism|evolution|quantum|particle|electron|enzyme|hypothesis)\b/,
  },
  {
    topic: 'engineering',
    re: /\b(engineering|engineer|manufacturing|manufacture|factory|assembly\s?line|machinery|mechanical|industrial|industry|construction|welding|blueprint|turbine|engine|hydraulic|pipeline|refinery|crane|excavator|fabrication|prototype)\b/,
  },
  {
    topic: 'technology',
    re: /\b(technology|software|hardware|computer|laptop|smartphone|coding|programming|algorithm|database|server|network|internet|ai|artificial\s?intelligence|machine\s?learning|neural\s?network|robot|robotic|automation|circuit|chip|semiconductor|processor|blockchain|virtual\s?reality|cyber|digital)\b/,
  },
  {
    topic: 'transport',
    re: /\b(car|automobile|vehicle|truck|bus|train|railway|locomotive|subway|tram|airplane|aircraft|aviation|helicopter|ship|boat|ferry|cargo|freight|bicycle|motorcycle|highway|traffic|transport|transit|logistics|harbou?r)\b/,
  },
  {
    topic: 'food',
    re: /\b(food|cooking|cuisine|recipe|meal|dish|kitchen|chef|baking|ingredient|restaurant|dining|gourmet|pasta|pizza|bread|dessert|coffee|breakfast|lunch|dinner|culinary|grill|barbecue|spice|nutrition)\b/,
  },
  {
    topic: 'urban',
    re: /\b(city|cityscape|urban|street|downtown|skyline|skyscraper|building|architecture|architectural|apartment|plaza|boulevard|avenue|bridge|tunnel|metro|neighbou?rhood|suburb|rooftop)\b/,
  },
  {
    topic: 'people',
    re: /\b(people|family|team|worker|crowd|community|friends|human|couple|elderly|generation|society|population)\b/,
  },
  {
    topic: 'business',
    re: /\b(business|finance|financial|economy|economic|currency|investment|investor|stock\s?market|banking|entrepreneur|corporate|corporation|office|marketing|commerce|accounting|revenue|wall\s?street)\b/,
  },
  {
    topic: 'education',
    re: /\b(education|educational|school|classroom|teacher|teaching|student|university|college|campus|lecture|tutorial|textbook|academic|curriculum|graduation)\b/,
  },
  {
    topic: 'travel',
    re: /\b(travel|tourism|tourist|vacation|holiday|destination|landmark|monument|sightseeing|backpacking|passport|resort|expedition|cruise|road\s?trip)\b/,
  },
];

function classifyByKeyword(text: string): Topic {
  const s = text.toLowerCase();
  for (const { topic, re } of RULES) {
    if (re.test(s)) return topic;
  }
  return 'generic';
}

// Classify a beat to a topic from its text AND its typed entities. Keyword pass first (it reads
// the whole beat and catches topical context that isn't a named entity); if that's inconclusive,
// the dominant visualizable entity's category decides (the LLM already disambiguated it).
export function classifyTopic(text: string, entities: readonly Entity[] = []): Topic {
  const byKeyword = classifyByKeyword(text);
  if (byKeyword !== 'generic') return byKeyword;
  for (const e of entities) {
    if (e.visualizable && e.canonical.length > 0) {
      const t = CATEGORY_TOPIC[e.category];
      if (t !== 'generic') return t;
    }
  }
  return 'generic';
}

// Archival film/photo sources that lead a HISTORICAL beat regardless of its topic (doc 25 §2 era
// routing: historical → Internet Archive / Library of Congress / Europeana; modern → stock/Flickr).
const HISTORICAL_SOURCES: readonly ProviderId[] = [
  'internet-archive',
  'library-of-congress',
  'europeana',
];

// Fan-out cap: a beat hits the few sources its topic + era warrant, never all of them (doc 25 §4)
// — keeps quota and latency bounded while lifting relevance.
export const MAX_TOPIC_SOURCES = 4;

// The ordered specialized sources a beat should query, from its topic + era. Historical beats
// lead with the archival sources, then their topic's own; deduped and capped.
export function routeTopicSources(topic: Topic, era: Era = 'timeless'): ProviderId[] {
  const base = TOPIC_SOURCES[topic];
  const merged: ProviderId[] = era === 'historical' ? [...HISTORICAL_SOURCES] : [];
  for (const s of base) {
    if (!merged.includes(s)) merged.push(s);
  }
  return merged.slice(0, MAX_TOPIC_SOURCES);
}
