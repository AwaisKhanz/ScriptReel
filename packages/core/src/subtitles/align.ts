// Pure forced-alignment mapping (doc 11): map whisper word timings onto the KNOWN
// script tokens. Matched tokens inherit whisper timings; unmatched runs interpolate
// by character weight; every token is clamped inside its beat (beats are truth).

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignBeat {
  idx: number;
  text: string;
  startSec: number;
  durationSec: number;
  language: string;
}

export interface AlignedWord {
  beatIdx: number;
  word: string;
  start: number;
  end: number;
}

const CJK = new Set(['ja', 'zh']);

function isCjk(language: string): boolean {
  return CJK.has(language.split('-')[0] ?? '');
}

export function normalizeToken(input: string): string {
  // Keep letters, numbers, and combining marks (Devanagari matras etc.).
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

function round3(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

interface ScriptToken {
  beatIdx: number;
  raw: string;
  norm: string;
  beatStart: number;
  beatEnd: number;
}

function tokenizeBeats(beats: readonly AlignBeat[]): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  for (const beat of beats) {
    const beatStart = beat.startSec;
    const beatEnd = beat.startSec + beat.durationSec;
    if (isCjk(beat.language)) {
      for (const ch of beat.text) {
        const norm = normalizeToken(ch);
        if (norm) tokens.push({ beatIdx: beat.idx, raw: ch, norm, beatStart, beatEnd });
      }
    } else {
      for (const raw of beat.text.trim().split(/\s+/)) {
        if (raw.length === 0) continue;
        tokens.push({ beatIdx: beat.idx, raw, norm: normalizeToken(raw), beatStart, beatEnd });
      }
    }
  }
  return tokens;
}

// LCS of two token-value sequences → monotonic matched index pairs.
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

// Fallback (E_ALIGN): distribute each beat's span across its tokens by char weight.
export function proportionalAlign(beats: readonly AlignBeat[]): AlignedWord[] {
  const out: AlignedWord[] = [];
  for (const beat of beats) {
    const tokens = tokenizeBeats([beat]);
    if (tokens.length === 0) continue;
    const beatEnd = beat.startSec + beat.durationSec;
    const weights = tokens.map((t) => Math.max(1, t.norm.length));
    const total = weights.reduce((acc, w) => acc + w, 0) || 1;
    let cursor = beat.startSec;
    tokens.forEach((token, k) => {
      const dur = (beatEnd - beat.startSec) * ((weights[k] ?? 1) / total);
      out.push({
        beatIdx: beat.idx,
        word: token.raw,
        start: round3(cursor),
        end: round3(cursor + dur),
      });
      cursor += dur;
    });
  }
  return out;
}

// Fraction of script tokens that matched a whisper token (for the ≥95% exit check).
export function tokenMatchRate(
  beats: readonly AlignBeat[],
  whisper: readonly WhisperWord[],
): number {
  const tokens = tokenizeBeats(beats);
  if (tokens.length === 0) return 0;
  const ww = whisper.map((w) => normalizeToken(w.word)).filter((n) => n.length > 0);
  if (ww.length === 0) return 0;
  return (
    lcsPairs(
      tokens.map((t) => t.norm),
      ww,
    ).length / tokens.length
  );
}

export function alignWords(
  beats: readonly AlignBeat[],
  whisper: readonly WhisperWord[],
): AlignedWord[] {
  const tokens = tokenizeBeats(beats);
  if (tokens.length === 0) return [];

  const globalStart = beats[0]?.startSec ?? 0;
  const lastBeat = beats[beats.length - 1];
  const globalEnd = lastBeat ? lastBeat.startSec + lastBeat.durationSec : globalStart;

  const ww = whisper
    .map((w) => ({ norm: normalizeToken(w.word), start: w.start, end: w.end }))
    .filter((w) => w.norm.length > 0);
  if (ww.length === 0) return proportionalAlign(beats);

  const pairs = lcsPairs(
    tokens.map((t) => t.norm),
    ww.map((w) => w.norm),
  );
  const matchStart = new Array<number | undefined>(tokens.length).fill(undefined);
  const matchEnd = new Array<number | undefined>(tokens.length).fill(undefined);
  for (const [ti, wi] of pairs) {
    const w = ww[wi];
    if (w) {
      matchStart[ti] = w.start;
      matchEnd[ti] = w.end;
    }
  }

  const start = new Array<number>(tokens.length).fill(0);
  const end = new Array<number>(tokens.length).fill(0);
  let k = 0;
  while (k < tokens.length) {
    const ms = matchStart[k];
    if (ms !== undefined) {
      start[k] = ms;
      end[k] = matchEnd[k] ?? ms;
      k += 1;
      continue;
    }
    // Unmatched run [k, runEnd): interpolate by char weight between anchors.
    let runEnd = k;
    while (runEnd < tokens.length && matchStart[runEnd] === undefined) runEnd += 1;
    const prevEnd = k > 0 ? (end[k - 1] ?? globalStart) : globalStart;
    const nextStart = runEnd < tokens.length ? (matchStart[runEnd] ?? globalEnd) : globalEnd;
    const span = Math.max(0, nextStart - prevEnd);
    let total = 0;
    for (let t = k; t < runEnd; t += 1) total += Math.max(1, tokens[t]?.norm.length ?? 1);
    let cursor = prevEnd;
    for (let t = k; t < runEnd; t += 1) {
      const dur = span * (Math.max(1, tokens[t]?.norm.length ?? 1) / (total || 1));
      start[t] = cursor;
      end[t] = cursor + dur;
      cursor += dur;
    }
    k = runEnd;
  }

  // Beat-snap + monotonic non-decreasing (doc 11 §3): beats are ground truth.
  const out: AlignedWord[] = [];
  let prevEndTime = globalStart;
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];
    if (!token) continue;
    const s = Math.max(start[t] ?? globalStart, token.beatStart, prevEndTime);
    const e = Math.max(s, Math.min(end[t] ?? s, token.beatEnd));
    out.push({ beatIdx: token.beatIdx, word: token.raw, start: round3(s), end: round3(e) });
    prevEndTime = e;
  }
  return out;
}
