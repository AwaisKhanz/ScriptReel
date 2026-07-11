// Per-beat domain classification (doc 23 §5) — a keyword heuristic over the beat's
// existing analysis fields (visualDescription + keyPhrase + entities), so no LLM
// change is needed. Drives which archive providers a beat is routed to.
export type Domain =
  | 'space'
  | 'nature'
  | 'science'
  | 'history'
  | 'art'
  | 'people'
  | 'urban'
  | 'tech'
  | 'generic';

// Ordered most-specific → most-generic; first match wins.
const RULES: { domain: Domain; re: RegExp }[] = [
  {
    domain: 'space',
    re: /\b(space|outer\s?space|moon|lunar|mars|martian|venus|jupiter|saturn|planet|planetary|galaxy|galaxies|nebula|cosmos|cosmic|universe|astronaut|cosmonaut|rocket|spacecraft|spaceship|orbit|orbital|satellite|nasa|apollo|gemini|voyager|hubble|telescope|comet|asteroid|meteor|solar\s?system|milky\s?way|star|stellar|eclipse|astronomy|astronomer)\b/,
  },
  {
    domain: 'nature',
    re: /\b(ocean|sea|wave|coral|reef|forest|jungle|rainforest|tree|mountain|river|lake|waterfall|desert|glacier|iceberg|volcano|wildlife|animal|bird|whale|dolphin|nature|landscape|sunrise|sunset|storm|hurricane|tornado|weather|climate|earth|arctic|antarctic|savanna|canyon|coast|cliff)\b/,
  },
  {
    domain: 'science',
    re: /\b(science|scientific|biology|biological|chemistry|chemical|physics|cell|cellular|molecule|molecular|atom|atomic|dna|gene|genetic|neuron|brain|microscope|laboratory|experiment|research|reaction|bacteria|virus|organism|evolution|energy|quantum)\b/,
  },
  {
    domain: 'history',
    re: /\b(history|historical|ancient|antiquity|century|centuries|medieval|renaissance|empire|dynasty|pharaoh|pyramid|castle|knight|king|queen|monarch|revolution|world\s?war|wwi|wwii|civilization|archaeolog|artifact|ruins|colonial|founding)\b/,
  },
  {
    domain: 'art',
    re: /\b(art|artwork|painting|painter|sculpture|sculptor|museum|gallery|fresco|mural|portrait|masterpiece|exhibit|canvas|drawing|illustration|craft|pottery|ceramic|design\s?movement)\b/,
  },
  {
    domain: 'tech',
    re: /\b(technology|software|hardware|computer|laptop|code|coding|programming|algorithm|data|server|network|internet|ai|artificial\s?intelligence|robot|robotic|circuit|chip|processor|app|startup|digital|cyber)\b/,
  },
  {
    domain: 'urban',
    re: /\b(city|cityscape|urban|street|downtown|skyline|skyscraper|building|traffic|subway|metro|bridge|highway|neighborhood|office|commuter|crowd)\b/,
  },
  {
    domain: 'people',
    re: /\b(person|people|man|woman|child|family|team|worker|portrait\s?of|face|hands|crowd|community|friends|group|human)\b/,
  },
];

export function classifyDomain(text: string): Domain {
  const s = text.toLowerCase();
  for (const { domain, re } of RULES) {
    if (re.test(s)) return domain;
  }
  return 'generic';
}
