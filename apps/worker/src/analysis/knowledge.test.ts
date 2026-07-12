import { describe, expect, it } from 'vitest';
import type { Claims } from '../providers/wikidata-commons';
import { eraFromClaims, extractTerms } from './knowledge';

// A Wikidata date claim: mainsnak.datavalue.value.time = "+1503-01-01T00:00:00Z".
function dateClaim(prop: string, time: string): Claims {
  return { [prop]: [{ mainsnak: { datavalue: { value: { time } } } }] };
}

describe('eraFromClaims', () => {
  it('a pre-1900 earliest date → historical', () => {
    expect(eraFromClaims(dateClaim('P571', '+1503-01-01T00:00:00Z'))).toBe('historical');
  });

  it('a modern date → modern', () => {
    expect(eraFromClaims(dateClaim('P571', '+2004-02-04T00:00:00Z'))).toBe('modern');
  });

  it('a BCE date → historical', () => {
    expect(eraFromClaims(dateClaim('P585', '-0044-03-15T00:00:00Z'))).toBe('historical');
  });

  it('takes the EARLIEST across multiple dates (born 1856, died 1943 → historical)', () => {
    const c: Claims = {
      ...dateClaim('P569', '+1856-07-10T00:00:00Z'),
      ...dateClaim('P570', '+1943-01-07T00:00:00Z'),
    };
    expect(eraFromClaims(c)).toBe('historical');
  });

  it('no dated claims → null', () => {
    expect(eraFromClaims({})).toBeNull();
  });

  it('ignores malformed time values', () => {
    expect(
      eraFromClaims({ P571: [{ mainsnak: { datavalue: { value: { time: 'nope' } } } }] }),
    ).toBeNull();
  });
});

describe('extractTerms', () => {
  it('pulls significant words from the lead sentence, skipping stopwords + the name', () => {
    const terms = extractTerms(
      'The Dead Sea is a salt lake bordered by Jordan and Israel. It is very deep.',
      ['Dead Sea'],
    );
    expect(terms).not.toContain('the'); // stopword
    expect(terms).not.toContain('dead'); // excluded name word
    expect(terms).not.toContain('sea'); // excluded name word
    expect(terms).toContain('salt');
    expect(terms.length).toBeLessThanOrEqual(3);
  });

  it('empty extract → []', () => {
    expect(extractTerms('', [])).toEqual([]);
  });

  it('caps at 3 terms, in order', () => {
    const terms = extractTerms('alpha bravo charlie delta echo foxtrot golf hotel', []);
    expect(terms).toEqual(['alpha', 'bravo', 'charlie']);
  });
});
