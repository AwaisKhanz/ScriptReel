import { describe, expect, it } from 'vitest';
import { OCR_COVERAGE_PENALTY, OCR_MAX_PENALTY, OCR_WATERMARK_PENALTY } from './constants';
import { type OcrResult, ocrGate } from './ocr-gate';

function read(overrides: Partial<OcrResult> = {}): OcrResult {
  return { text: '', coverage: 0, wordCount: 0, ...overrides };
}

describe('ocrGate', () => {
  it('passes a clean image with no penalty or veto', () => {
    const v = ocrGate(read(), { era: 'timeless' });
    expect(v).toEqual({ penalty: 0, veto: false, reason: '' });
  });

  it('treats empty text with zero coverage as clean', () => {
    const v = ocrGate(read({ text: '', coverage: 0, wordCount: 0 }), { era: 'historical' });
    expect(v.penalty).toBe(0);
    expect(v.veto).toBe(false);
    expect(v.reason).toBe('');
  });

  it('penalizes a stock-domain watermark without vetoing', () => {
    const v = ocrGate(read({ text: 'Getty Images', coverage: 0.02, wordCount: 2 }), {
      era: 'modern',
    });
    expect(v.veto).toBe(false);
    expect(v.penalty).toBeGreaterThan(0);
    expect(v.penalty).toBeCloseTo(OCR_WATERMARK_PENALTY); // coverage below the floor ⇒ watermark only
    expect(v.reason).toContain('watermark:getty');
  });

  it('grows the penalty as text coverage rises, then vetoes above the ceiling', () => {
    const low = ocrGate(read({ text: 'lower third caption', coverage: 0.08 }), { era: 'timeless' });
    const high = ocrGate(read({ text: 'big caption', coverage: 0.2 }), { era: 'timeless' });
    expect(low.veto).toBe(false);
    expect(high.veto).toBe(false);
    expect(high.penalty).toBeGreaterThan(low.penalty);
    // At/above OCR_COVERAGE_CEIL (0.22) the coverage penalty saturates at its max.
    const saturated = ocrGate(read({ text: 'x', coverage: 0.3 }), { era: 'timeless' });
    expect(saturated.penalty).toBeCloseTo(OCR_COVERAGE_PENALTY);
    // Above OCR_COVERAGE_VETO (0.35) the image is mostly text → veto.
    const overlay = ocrGate(read({ text: 'full screen text', coverage: 0.4 }), { era: 'timeless' });
    expect(overlay.veto).toBe(true);
    expect(overlay.reason).toContain('veto:overlay');
  });

  it('vetoes a modern year burned into a historical beat', () => {
    const v = ocrGate(read({ text: 'filmed on location 1998', coverage: 0.05 }), {
      era: 'historical',
    });
    expect(v.veto).toBe(true);
    expect(v.reason).toBe('veto:era-1998');
  });

  it('does not veto an old year on a historical beat', () => {
    const v = ocrGate(read({ text: 'the year 1503', coverage: 0.05 }), { era: 'historical' });
    expect(v.veto).toBe(false);
  });

  it('does not veto an old year on a modern beat (only historical → modern direction)', () => {
    const v = ocrGate(read({ text: 'anno 1600', coverage: 0.05 }), { era: 'modern' });
    expect(v.veto).toBe(false);
  });

  it('does not veto a modern year on a modern beat', () => {
    const v = ocrGate(read({ text: 'copyright 2020', coverage: 0.02 }), { era: 'modern' });
    expect(v.veto).toBe(false);
    expect(v.penalty).toBeGreaterThan(0); // 'copyright' is still a watermark token
  });

  it('caps the combined penalty at OCR_MAX_PENALTY', () => {
    // Watermark (0.12) + saturated coverage (0.15) = 0.27, capped to 0.25, still no veto.
    const v = ocrGate(read({ text: 'shutterstock preview', coverage: 0.3, wordCount: 2 }), {
      era: 'modern',
    });
    expect(v.veto).toBe(false);
    expect(v.penalty).toBe(OCR_MAX_PENALTY);
  });
});
