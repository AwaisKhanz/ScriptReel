import { describe, expect, it } from 'vitest';
import { pickSpreadFrames } from './pexels';

describe('pickSpreadFrames', () => {
  it('returns [] for an empty list', () => {
    expect(pickSpreadFrames([])).toEqual([]);
  });

  it('returns the single element for a one-frame clip', () => {
    expect(pickSpreadFrames(['a.jpg'])).toEqual(['a.jpg']);
  });

  it('picks 3 frames at ≈10/50/90% across a long list, in order', () => {
    // len 11 → indices floor(10*0.1)=1, floor(10*0.5)=5, floor(10*0.9)=9
    const pics = Array.from({ length: 11 }, (_, i) => `f${i}.jpg`);
    expect(pickSpreadFrames(pics)).toEqual(['f1.jpg', 'f5.jpg', 'f9.jpg']);
  });

  it('de-duplicates when spread indices collapse on short lists, preserving order', () => {
    // len 3 → indices floor(2*0.1)=0, floor(2*0.5)=1, floor(2*0.9)=1 → [0,1] deduped
    expect(pickSpreadFrames(['a.jpg', 'b.jpg', 'c.jpg'])).toEqual(['a.jpg', 'b.jpg']);
    // len 2 → indices all floor(1*frac)=0 → collapse to the first
    expect(pickSpreadFrames(['a.jpg', 'b.jpg'])).toEqual(['a.jpg']);
  });
});
