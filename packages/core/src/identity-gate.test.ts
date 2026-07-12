import { describe, expect, it } from 'vitest';
import { IDENTITY_DINO_TAU, IDENTITY_FACE_TAU, IDENTITY_MISMATCH_PENALTY } from './constants';
import { identityGate, identityMethodFor } from './identity-gate';

describe('identityGate', () => {
  it('vetoes a person mismatch (face cosine below τ)', () => {
    const v = identityGate(IDENTITY_FACE_TAU - 0.05, 'face');
    expect(v.veto).toBe(true);
    expect(v.penalty).toBe(0);
    expect(v.reason).toContain('identity:face-');
  });

  it('passes a person match clean (face cosine at/above τ)', () => {
    const v = identityGate(IDENTITY_FACE_TAU + 0.1, 'face');
    expect(v).toEqual({ veto: false, penalty: 0, reason: '' });
  });

  it('penalizes a landmark mismatch without vetoing (dino cosine below τ)', () => {
    const v = identityGate(IDENTITY_DINO_TAU - 0.1, 'dino');
    expect(v.veto).toBe(false);
    expect(v.penalty).toBeCloseTo(IDENTITY_MISMATCH_PENALTY);
    expect(v.reason).toContain('identity:dino-');
  });

  it('passes a landmark match clean (dino cosine at/above τ)', () => {
    const v = identityGate(IDENTITY_DINO_TAU + 0.05, 'dino');
    expect(v).toEqual({ veto: false, penalty: 0, reason: '' });
  });
});

describe('identityMethodFor', () => {
  it('routes person → face', () => {
    expect(identityMethodFor('person')).toBe('face');
  });

  it('routes landmark / building / artwork → dino', () => {
    expect(identityMethodFor('landmark')).toBe('dino');
    expect(identityMethodFor('building')).toBe('dino');
    expect(identityMethodFor('artwork')).toBe('dino');
  });

  it('returns null for an unmapped category', () => {
    expect(identityMethodFor('concept')).toBeNull();
    expect(identityMethodFor('animal')).toBeNull();
  });
});
