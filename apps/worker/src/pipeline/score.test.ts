import { describe, expect, it } from 'vitest';
import { framesOf } from './score';

describe('framesOf', () => {
  it('returns meta.frames when it is a non-empty string array', () => {
    expect(
      framesOf({ meta: { frames: ['a.jpg', 'b.jpg', 'c.jpg'] }, thumb_path: 'b.jpg' }),
    ).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('filters non-string entries out of the frames array', () => {
    expect(
      framesOf({ meta: { frames: ['a.jpg', 42, null, 'b.jpg'] }, thumb_path: 't.jpg' }),
    ).toEqual(['a.jpg', 'b.jpg']);
  });

  it('falls back to [thumb_path] when meta is null', () => {
    expect(framesOf({ meta: null, thumb_path: 't.jpg' })).toEqual(['t.jpg']);
  });

  it('falls back to [thumb_path] when meta has no frames array', () => {
    expect(framesOf({ meta: { tinyUrl: 'x' }, thumb_path: 't.jpg' })).toEqual(['t.jpg']);
  });

  it('falls back to [thumb_path] on malformed or empty frames', () => {
    expect(framesOf({ meta: { frames: 'nope' }, thumb_path: 't.jpg' })).toEqual(['t.jpg']);
    expect(framesOf({ meta: { frames: [] }, thumb_path: 't.jpg' })).toEqual(['t.jpg']);
    expect(framesOf({ meta: [1, 2, 3], thumb_path: 't.jpg' })).toEqual(['t.jpg']);
  });

  it('returns [] when there is neither a frames array nor a thumb_path', () => {
    expect(framesOf({ meta: null, thumb_path: null })).toEqual([]);
  });
});
