import { describe, expect, it } from 'vitest';
import type { Entity, EntityCategory } from './analysis';
import {
  classifyTopic,
  MAX_TOPIC_SOURCES,
  routeTopicSources,
  TOPIC_SOURCES,
  type Topic,
} from './topics';

function entity(canonical: string, category: EntityCategory, visualizable = true): Entity {
  return {
    surface: canonical,
    canonical,
    category,
    instanceOf: '',
    disambiguation: '',
    searchTerms: [],
    visualizable,
  };
}

describe('classifyTopic — keyword coverage across the full category spread', () => {
  it('routes topical beats to the right topic', () => {
    expect(classifyTopic('Apollo 11 lunar module descends toward the Moon')).toBe('space');
    expect(classifyTopic('a surgeon performing open heart surgery in a hospital')).toBe('medicine');
    expect(classifyTopic('a coral reef teeming with fish in a warm ocean')).toBe('ocean');
    expect(classifyTopic('a hurricane forming over the warm Atlantic, storm clouds')).toBe(
      'weather',
    );
    expect(classifyTopic('an elephant walking through the savanna at dawn')).toBe('nature');
    expect(classifyTopic('molten lava erupting from an active volcano')).toBe('earth');
    expect(classifyTopic('a medieval castle during the Renaissance')).toBe('history');
    expect(classifyTopic('a Renaissance fresco in a museum gallery')).toBe('history'); // history wins over art
    expect(classifyTopic('a single cell divides under a microscope')).toBe('science');
    expect(classifyTopic('a robotic arm on a car factory assembly line')).toBe('engineering');
    expect(classifyTopic('developers writing software on laptops, AI models')).toBe('technology');
    expect(classifyTopic('a high-speed train racing past on the railway')).toBe('transport');
    expect(classifyTopic('a chef plating fresh pasta in a restaurant kitchen')).toBe('food');
    expect(classifyTopic('a busy downtown street with a glass skyscraper skyline')).toBe('urban');
    expect(classifyTopic('quarterly revenue growth and stock market investment')).toBe('business');
    expect(classifyTopic('students studying in a university classroom')).toBe('education');
    expect(classifyTopic('a tourist exploring a famous landmark on vacation')).toBe('travel');
  });

  it('falls back to a visualizable entity category when no keyword matches', () => {
    // "a plate of X" has no topic keyword — the typed entity decides.
    expect(classifyTopic('a plate of it on the table', [entity('pasta', 'object')])).toBe(
      'generic',
    );
    expect(classifyTopic('the sixth one from the sun', [entity('Saturn', 'planet')])).toBe('space');
    expect(classifyTopic('it prowls at night', [entity('leopard', 'animal')])).toBe('nature');
    expect(classifyTopic('its logo is everywhere', [entity('Apple Inc.', 'company')])).toBe(
      'business',
    );
  });

  it('ignores non-visualizable entities and returns generic', () => {
    expect(classifyTopic('a quiet moment of reflection', [entity('doubt', 'concept', false)])).toBe(
      'generic',
    );
    expect(classifyTopic('')).toBe('generic');
  });
});

describe('routeTopicSources — topic + era fan-out', () => {
  it('returns a topic’s specialized sources, best-first', () => {
    expect(routeTopicSources('space')).toEqual(['nasa', 'wikimedia']);
    expect(routeTopicSources('nature')).toEqual(['inaturalist', 'usgs', 'wikimedia', 'flickr']);
    expect(routeTopicSources('generic')).toEqual([]);
    expect(routeTopicSources('business')).toEqual([]);
  });

  it('leads historical beats with archival film/photo sources regardless of topic', () => {
    const historicalSpace = routeTopicSources('space', 'historical');
    expect(historicalSpace.slice(0, 3)).toEqual([
      'internet-archive',
      'library-of-congress',
      'europeana',
    ]);
    // a generic historical beat still gets the archival trio
    expect(routeTopicSources('generic', 'historical')).toEqual([
      'internet-archive',
      'library-of-congress',
      'europeana',
    ]);
  });

  it('modern/timeless eras do not prepend the archival sources', () => {
    expect(routeTopicSources('space', 'modern')).toEqual(['nasa', 'wikimedia']);
    expect(routeTopicSources('space', 'timeless')).toEqual(['nasa', 'wikimedia']);
  });

  it('never fans out to more than MAX_TOPIC_SOURCES', () => {
    for (const topic of Object.keys(TOPIC_SOURCES) as Topic[]) {
      expect(routeTopicSources(topic, 'historical').length).toBeLessThanOrEqual(MAX_TOPIC_SOURCES);
    }
  });
});
