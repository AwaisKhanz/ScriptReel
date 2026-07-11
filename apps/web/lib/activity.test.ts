import { describe, expect, it } from 'vitest';
import { detailText, parseDetail } from './activity';

describe('pipeline activity detail', () => {
  it('parses a structured event', () => {
    const e = parseDetail(
      '{"op":"search","provider":"pexels","kind":"video","query":"crowded subway","found":18}',
    );
    expect(e?.op).toBe('search');
    expect(
      detailText(
        '{"op":"search","provider":"pexels","kind":"video","query":"crowded subway","found":18}',
      ),
    ).toBe('Searching pexels videos · “crowded subway” — 18 found');
  });

  it('passes plain-text details through unchanged', () => {
    expect(parseDetail('aligning with whisper')).toBeNull();
    expect(detailText('aligning with whisper')).toBe('aligning with whisper');
  });

  it('never throws on malformed JSON and falls back to the raw string', () => {
    expect(parseDetail('{broken')).toBeNull();
    expect(detailText('{broken')).toBe('{broken');
  });

  it('formats the per-item events', () => {
    expect(detailText('{"op":"beat","beat":3,"of":12}')).toBe('Beat 3/12 sourced');
    expect(detailText('{"op":"embed","done":40,"total":120}')).toBe('Analyzing visuals 40/120');
    expect(detailText('{"op":"select","beat":2,"of":12}')).toBe('Matching beat 2/12');
    expect(detailText('{"op":"download","provider":"pexels","kind":"video","n":4}')).toBe(
      'Downloading pexels clip · 4 fetched',
    );
    expect(detailText('{"op":"normalize","beat":5,"of":12}')).toBe('Cutting clip 5/12');
    expect(detailText('{"op":"tts","beat":1,"of":12}')).toBe('Narrating beat 1/12');
  });

  it('unknown op → null (UI hides rather than shows raw JSON)', () => {
    expect(detailText('{"op":"future-thing"}')).toBeNull();
  });
});
