import type { Era } from './analysis';
import {
  OCR_COVERAGE_CEIL,
  OCR_COVERAGE_FLOOR,
  OCR_COVERAGE_PENALTY,
  OCR_COVERAGE_VETO,
  OCR_ERA_MODERN_YEAR,
  OCR_MAX_PENALTY,
  OCR_WATERMARK_PENALTY,
} from './constants';

// The OCR gate (doc 25 §5, cascade A) — pure decision logic, zero I/O (invariant 8).
// The sidecar runs Tesseract on a beat's SigLIP top-5 shortlist; this turns each
// candidate's read-back text + coverage into a penalty (watermark / heavy overlay
// lowers the score) or a veto (drop the candidate outright).

// One OCR read of a single thumbnail: the joined text of the kept high-confidence
// words, the fraction of the image those word boxes cover, and how many there were.
export interface OcrResult {
  text: string;
  coverage: number;
  wordCount: number;
}

// The only beat context the gate needs: the era, for the burned-in-date contradiction
// check (a modern date on a historical beat is wrong; the reverse is legitimate).
export interface OcrGateBeat {
  era: Era;
}

export interface OcrVerdict {
  penalty: number; // subtracted un-multiplied in rankBeat; 0 when clean
  veto: boolean; // true ⇒ drop the candidate before selection sees it
  reason: string; // compact human string for the selection log; '' when clean
}

// Stock-site domains + copyright marks + provider names that, burned into an image,
// mark it as watermarked. Kept next to the gate (its only consumer); the numeric
// thresholds live in constants.ts. Provider names for allowed sources (pexels /
// pixabay / unsplash) are included: a burned-in provider logo is a watermark even
// when the license is fine.
export const WATERMARK_PATTERNS: readonly string[] = [
  'shutterstock',
  'getty',
  'gettyimages',
  'istock',
  'istockphoto',
  'alamy',
  'dreamstime',
  'depositphotos',
  '123rf',
  'vecteezy',
  'pond5',
  'videoblocks',
  'storyblocks',
  'envato',
  'adobe stock',
  'stock.adobe',
  'pexels',
  'pixabay',
  'unsplash',
  '©',
  '(c)',
  'copyright',
  'www.',
  '.com/',
  'preview',
];

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// Score one shortlisted candidate's OCR read against the beat. Veto is independent of
// penalty: an egregious full-image overlay, or a modern date burned into a historical
// beat, drops the candidate outright regardless of any watermark penalty.
export function ocrGate(ocr: OcrResult, beat: OcrGateBeat): OcrVerdict {
  const text = ocr.text.toLowerCase();
  const coverage = clamp(ocr.coverage, 0, 1);

  // --- Veto (drop outright) ------------------------------------------------
  // Egregious overlay: the image is mostly text / graphic, not the subject.
  if (coverage >= OCR_COVERAGE_VETO) {
    return { penalty: 0, veto: true, reason: `veto:overlay-${coverage.toFixed(2)}` };
  }
  // Era contradiction — ONLY one direction (conservative): a modern date burned into a
  // historical beat is wrong. A modern video may legitimately show a historic date, so
  // we never veto a modern beat on an old year.
  if (beat.era === 'historical') {
    const years = text.match(/\b(1\d{3}|20\d{2})\b/g);
    if (years) {
      for (const y of years) {
        if (Number(y) >= OCR_ERA_MODERN_YEAR) {
          return { penalty: 0, veto: true, reason: `veto:era-${y}` };
        }
      }
    }
  }

  // --- Penalty (watermark + coverage), summed then capped ------------------
  const parts: string[] = [];
  let penalty = 0;

  const hit = WATERMARK_PATTERNS.find((p) => text.includes(p));
  if (hit) {
    penalty += OCR_WATERMARK_PENALTY;
    parts.push(`watermark:${hit}`);
  }

  const coveragePenalty =
    OCR_COVERAGE_PENALTY *
    clamp((coverage - OCR_COVERAGE_FLOOR) / (OCR_COVERAGE_CEIL - OCR_COVERAGE_FLOOR), 0, 1);
  if (coveragePenalty > 0) {
    penalty += coveragePenalty;
    parts.push(`coverage:${coverage.toFixed(2)}`);
  }

  return { penalty: Math.min(penalty, OCR_MAX_PENALTY), veto: false, reason: parts.join(' ') };
}
