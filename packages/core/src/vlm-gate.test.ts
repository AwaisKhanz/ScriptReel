import { describe, expect, it } from 'vitest';
import { VLM_ERA_PENALTY, VLM_MAX_PENALTY, VLM_SHOT_PENALTY, VLM_SKIP_MARGIN } from './constants';
import { type VlmChecklist, vlmGate, vlmNeeded } from './vlm-gate';

const clean: VlmChecklist = {
  subjectPresent: true,
  shotTypeMatches: true,
  eraMatches: true,
  contradictingText: false,
};

describe('vlmGate', () => {
  it('vetoes when the subject is absent (regardless of the other fields)', () => {
    const v = vlmGate({ ...clean, subjectPresent: false, eraMatches: false });
    expect(v.veto).toBe(true);
    expect(v.penalty).toBe(0);
    expect(v.reason).toBe('vlm:no-subject');
  });

  it('vetoes on contradicting on-screen text', () => {
    const v = vlmGate({ ...clean, contradictingText: true });
    expect(v.veto).toBe(true);
    expect(v.penalty).toBe(0);
    expect(v.reason).toBe('vlm:contradicting-text');
  });

  it('penalizes (not vetoes) an era mismatch', () => {
    const v = vlmGate({ ...clean, eraMatches: false });
    expect(v.veto).toBe(false);
    expect(v.penalty).toBeCloseTo(VLM_ERA_PENALTY);
    expect(v.reason).toBe('vlm:era');
  });

  it('applies a small penalty for a shot-framing miss only', () => {
    const v = vlmGate({ ...clean, shotTypeMatches: false });
    expect(v.veto).toBe(false);
    expect(v.penalty).toBeCloseTo(VLM_SHOT_PENALTY);
    expect(v.reason).toBe('vlm:shot');
  });

  it('sums era + shot penalties and caps at VLM_MAX_PENALTY', () => {
    const v = vlmGate({ ...clean, eraMatches: false, shotTypeMatches: false });
    expect(v.veto).toBe(false);
    expect(v.penalty).toBeCloseTo(Math.min(VLM_ERA_PENALTY + VLM_SHOT_PENALTY, VLM_MAX_PENALTY));
    expect(v.reason).toBe('vlm:era+shot');
  });

  it('passes a clean checklist through untouched', () => {
    expect(vlmGate(clean)).toEqual({ veto: false, penalty: 0, reason: '' });
  });
});

describe('vlmNeeded', () => {
  it('always runs when the beat names an entity, even with a strong margin', () => {
    expect(vlmNeeded(true, 1)).toBe(true);
    expect(vlmNeeded(true, VLM_SKIP_MARGIN + 0.5)).toBe(true);
  });

  it('skips a no-entity beat with a strong SigLIP margin', () => {
    expect(vlmNeeded(false, VLM_SKIP_MARGIN + 0.01)).toBe(false);
    expect(vlmNeeded(false, Number.POSITIVE_INFINITY)).toBe(false); // single-candidate beat
  });

  it('runs a no-entity beat when the margin is weak (contested top pick)', () => {
    expect(vlmNeeded(false, VLM_SKIP_MARGIN - 0.01)).toBe(true);
    expect(vlmNeeded(false, 0)).toBe(true);
  });
});
