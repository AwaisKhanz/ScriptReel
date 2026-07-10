import type { AlignedWord } from './align';
import { fontForLanguage, PRESETS, type SubtitleAspect, type SubtitlePreset } from './presets';

// buildAss(words, preset, aspect, language) → ASS string (doc 11 §ASS generation).
// Pure: the composer writes this to render.ass and burns it with libass.

const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;
const LEAD_IN = 0.08;
const TAIL = 0.12;

interface AssEvent {
  start: number;
  end: number;
  text: string;
}

function isCjk(language: string): boolean {
  const base = language.split('-')[0];
  return base === 'ja' || base === 'zh';
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function assTime(seconds: number): string {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalS = Math.floor(totalCs / 100);
  const ss = totalS % 60;
  const mm = Math.floor(totalS / 60) % 60;
  const hh = Math.floor(totalS / 3600);
  return `${hh}:${pad2(mm)}:${pad2(ss)}.${pad2(cs)}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');
}

function groupByBeat(words: readonly AlignedWord[]): AlignedWord[][] {
  const groups: AlignedWord[][] = [];
  let current: AlignedWord[] = [];
  let beatIdx: number | null = null;
  for (const word of words) {
    if (word.beatIdx !== beatIdx) {
      if (current.length > 0) groups.push(current);
      current = [];
      beatIdx = word.beatIdx;
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function styleLine(preset: SubtitlePreset, aspect: SubtitleAspect, language: string): string {
  const p = PRESETS[preset];
  const font = fontForLanguage(language, p.latinFont);
  const size = p.sizes[aspect];
  return `Style: Default,${font},${size},${p.primary},${p.secondary},${p.outline},${p.back},${p.bold},0,0,0,100,100,${p.spacing},0,${p.borderStyle},${p.outlineWidth},${p.shadow},${p.alignment},${p.marginL},${p.marginR},${p.marginV},1`;
}

function header(preset: SubtitlePreset, aspect: SubtitleAspect, language: string): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine(preset, aspect, language),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text',
  ].join('\n');
}

// Caption events (clean/lowerthird/documentary): greedy line fill, ≤2 lines/event.
function captionEvents(
  words: readonly AlignedWord[],
  preset: SubtitlePreset,
  language: string,
): AssEvent[] {
  const cjk = isCjk(language);
  const sep = cjk ? '' : ' ';
  const maxChars = Math.round(PRESETS[preset].maxCharsPerLine * (cjk ? 0.6 : 1));
  const events: AssEvent[] = [];

  for (const beatWords of groupByBeat(words)) {
    const lineWords: AlignedWord[][] = [[]];
    const lineText: string[] = [''];
    for (const word of beatWords) {
      const li = lineText.length - 1;
      const current = lineText[li] ?? '';
      const tentative = current ? current + sep + word.word : word.word;
      if (current.length > 0 && maxChars > 0 && tentative.length > maxChars) {
        lineWords.push([word]);
        lineText.push(word.word);
      } else {
        (lineWords[li] ?? []).push(word);
        lineText[li] = tentative;
      }
    }
    for (let i = 0; i < lineText.length; i += 2) {
      const chunkWords = [...(lineWords[i] ?? []), ...(lineWords[i + 1] ?? [])];
      if (chunkWords.length === 0) continue;
      const lines = [lineText[i], lineText[i + 1]].filter((l): l is string => Boolean(l));
      const start = (chunkWords[0]?.start ?? 0) - LEAD_IN;
      const end = (chunkWords[chunkWords.length - 1]?.end ?? 0) + TAIL;
      // Escape each line, THEN join with the ASS \N break (never escape \N itself).
      events.push({ start, end, text: lines.map(escapeAss).join('\\N') });
    }
  }
  return events;
}

// Karaoke events (pop): 1–3 word groups (2–4 chars CJK); active word sweeps
// Secondary(white) → Primary(accent) via {\k} (doc 11 §karaoke).
function karaokeEvents(words: readonly AlignedWord[], language: string): AssEvent[] {
  const cjk = isCjk(language);
  const groupSize = cjk ? 4 : 3;
  const sep = cjk ? '' : ' ';
  const events: AssEvent[] = [];

  for (const beatWords of groupByBeat(words)) {
    for (let i = 0; i < beatWords.length; i += groupSize) {
      const group = beatWords.slice(i, i + groupSize);
      const first = group[0];
      const last = group[group.length - 1];
      if (!first || !last) continue;
      const karaoke = group
        .map((w) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${escapeAss(w.word)}`)
        .join(sep);
      events.push({
        start: first.start,
        end: last.end,
        text: `{\\fad(60,0)\\t(0,120,\\fscx105\\fscy105)}${karaoke}`,
      });
    }
  }
  return events;
}

function clampAndFormat(events: AssEvent[]): string[] {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (cur && next && cur.end > next.start) cur.end = next.start;
    if (cur && cur.end < cur.start) cur.end = cur.start;
  }
  return sorted.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Default,${e.text}`);
}

export interface BuildAssInput {
  words: readonly AlignedWord[];
  preset: SubtitlePreset;
  aspect: SubtitleAspect;
  language: string;
}

export function buildAss(input: BuildAssInput): string {
  const { words, preset, aspect, language } = input;
  const events =
    preset === 'pop' ? karaokeEvents(words, language) : captionEvents(words, preset, language);
  return `${header(preset, aspect, language)}\n${clampAndFormat(events).join('\n')}\n`;
}
