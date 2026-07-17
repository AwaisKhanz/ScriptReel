import { describe, expect, it } from 'vitest';
import { CATEGORY_DEFAULT_WANT, type Entity } from './analysis';
import {
  CATEGORY_SOURCES,
  INSTANCE_OF_QID,
  namesSubject,
  parseEntities,
  parseShots,
  WANT_TO_PROPERTY,
} from './entity-routing';

const ent = (over: Partial<Entity> = {}): Entity => ({
  surface: 'x',
  canonical: 'X',
  category: 'concept',
  instanceOf: '',
  disambiguation: '',
  searchTerms: [],
  visualizable: true,
  ...over,
});

describe('namesSubject', () => {
  it('true for a visualizable named entity (country, lake, person…)', () => {
    expect(namesSubject([ent({ canonical: 'Jordan', category: 'country' })])).toBe(true);
    expect(namesSubject([ent({ canonical: 'Dead Sea', category: 'lake' })])).toBe(true);
  });
  it('false for pure concepts, non-visualizable, or empty', () => {
    expect(namesSubject([ent({ canonical: 'freedom', category: 'concept' })])).toBe(false);
    expect(namesSubject([ent({ category: 'country', visualizable: false })])).toBe(false);
    expect(namesSubject([])).toBe(false);
  });
});

describe('parseEntities / parseShots', () => {
  it('keeps valid items, drops malformed ones', () => {
    const parsed = parseEntities([
      {
        surface: 'the Dead Sea',
        canonical: 'Dead Sea',
        category: 'lake',
        instanceOf: 'lake',
        disambiguation: '',
        searchTerms: [],
        visualizable: true,
      },
      { nope: true },
      42,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.canonical).toBe('Dead Sea');
  });
  it('parseShots applies schema defaults and drops junk', () => {
    const shots = parseShots([{ phrase: 'dead sea aerial view' }, { bad: 1 }]);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      phrase: 'dead sea aerial view',
      entity: '',
      want: 'generic',
      weight: 1,
    });
  });
  it('non-array input → []', () => {
    expect(parseEntities(null)).toEqual([]);
    expect(parseShots(undefined)).toEqual([]);
  });
});

describe('routing maps are total + coherent', () => {
  it('every category has a default want', () => {
    for (const cat of Object.keys(CATEGORY_SOURCES)) {
      expect(CATEGORY_DEFAULT_WANT).toHaveProperty(cat);
    }
  });
  it('country → wikidata-commons; planet also → nasa; concept → none', () => {
    expect(CATEGORY_SOURCES.country).toContain('wikidata-commons');
    expect(CATEGORY_SOURCES.planet).toContain('nasa');
    expect(CATEGORY_SOURCES.concept).toEqual([]);
  });
  it('want→property: flag=P41, map includes P242, footage/generic empty', () => {
    expect(WANT_TO_PROPERTY.flag).toEqual(['P41']);
    expect(WANT_TO_PROPERTY.map).toContain('P242');
    expect(WANT_TO_PROPERTY.footage).toEqual([]);
    expect(WANT_TO_PROPERTY.generic).toEqual([]);
  });
  it('instance-of Q-ids: the live-verified anchors', () => {
    expect(INSTANCE_OF_QID.lake).toBe('Q23397');
    expect(INSTANCE_OF_QID.country).toBe('Q6256');
    expect(INSTANCE_OF_QID.planet).toBe('Q634');
    expect(INSTANCE_OF_QID.human).toBe('Q5');
  });
});
