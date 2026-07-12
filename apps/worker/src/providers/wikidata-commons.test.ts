import { describe, expect, it } from 'vitest';
import { type Claims, claimEntityIds, claimStrings, filenamesForWant } from './wikidata-commons';

const claims: Claims = {
  P18: [
    { mainsnak: { datavalue: { value: 'Dead Sea A.jpg' } } },
    { mainsnak: { datavalue: { value: 'Dead Sea B.jpg' } }, rank: 'preferred' },
  ],
  P41: [{ mainsnak: { datavalue: { value: 'Flag of Jordan.svg' } } }],
  P242: [{ mainsnak: { datavalue: { value: 'LocationJordan.svg' } } }],
  P31: [
    { mainsnak: { datavalue: { value: { id: 'Q23397' } } } },
    { mainsnak: { datavalue: { value: { id: 'Q9430' } } } },
  ],
};

describe('claimStrings', () => {
  it('returns filenames, preferred rank first', () => {
    expect(claimStrings(claims, 'P18')).toEqual(['Dead Sea B.jpg', 'Dead Sea A.jpg']);
  });
  it('empty for a missing property', () => {
    expect(claimStrings(claims, 'P999')).toEqual([]);
  });
});

describe('claimEntityIds', () => {
  it('extracts P31 instance-of Q-ids (used to verify the sense)', () => {
    expect(claimEntityIds(claims, 'P31')).toEqual(['Q23397', 'Q9430']);
  });
});

describe('filenamesForWant', () => {
  it('maps a want to the right Commons property files', () => {
    expect(filenamesForWant(claims, 'flag')).toEqual(['Flag of Jordan.svg']);
    expect(filenamesForWant(claims, 'map')).toEqual(['LocationJordan.svg']);
    // aerial tries P8592 → P948 → P18; only P18 present → its files, preferred first
    expect(filenamesForWant(claims, 'aerial')).toEqual(['Dead Sea B.jpg', 'Dead Sea A.jpg']);
  });
  it('footage/generic have no still property → empty', () => {
    expect(filenamesForWant(claims, 'footage')).toEqual([]);
    expect(filenamesForWant(claims, 'generic')).toEqual([]);
  });
});
