// ASS style presets — canonical params from doc 17 §subtitle presets. Colors are
// ASS &HAABBGGRR (AA=00 opaque). PlayRes matches the render aspect (uniform 1:1
// script→pixel mapping) so captions never distort or overflow on 9:16 / 1:1.

export type SubtitlePreset = 'clean' | 'pop' | 'lowerthird' | 'documentary';
export type SubtitleAspect = '16:9' | '9:16' | '1:1';

// Script resolution per aspect = the real render dimensions (doc 13). Keeping this
// equal to the frame makes libass's scale uniform, so font sizes/margins are in
// true pixels — a 1920×1080 PlayRes on a 1080×1920 frame is what caused the
// portrait caption overflow.
export const PLAY_RES: Record<SubtitleAspect, { x: number; y: number }> = {
  '16:9': { x: 1920, y: 1080 },
  '9:16': { x: 1080, y: 1920 },
  '1:1': { x: 1080, y: 1080 },
};

export interface PresetSpec {
  latinFont: string;
  bold: 0 | -1;
  sizes: Record<SubtitleAspect, number>;
  primary: string;
  secondary: string;
  outline: string;
  back: string;
  borderStyle: 1 | 3;
  outlineWidth: number;
  shadow: number;
  spacing: number;
  alignment: number; // 2 bottom, 5 middle, 8 top, 1 bottom-left
  marginL: number;
  marginR: number;
  marginV: Record<SubtitleAspect, number>; // portrait needs a larger bottom safe area
  maxChars: Record<SubtitleAspect, number>; // per-line wrap; narrower frames fit fewer (0 = word groups, pop)
}

export const PRESETS: Record<SubtitlePreset, PresetSpec> = {
  clean: {
    latinFont: 'Inter',
    bold: -1,
    sizes: { '16:9': 54, '9:16': 50, '1:1': 50 },
    primary: '&H00E8EBF0',
    secondary: '&H00000000',
    outline: '&HC0000000',
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 2.5,
    shadow: 0,
    spacing: 0,
    alignment: 2,
    marginL: 60,
    marginR: 60,
    marginV: { '16:9': 90, '9:16': 220, '1:1': 110 },
    maxChars: { '16:9': 42, '9:16': 26, '1:1': 28 },
  },
  pop: {
    latinFont: 'Inter',
    bold: -1,
    sizes: { '16:9': 76, '9:16': 80, '1:1': 78 },
    primary: '&H00FF5C7C', // accent (BGR) — the sung/active word
    secondary: '&H00FFFFFF', // white — upcoming
    // doc 17 lists &HFF0A0C10 (AA=FF = a fully transparent, i.e. invisible, 4px
    // outline — a typo). Use the --bg token opaque so karaoke stays legible.
    outline: '&H000A0C10',
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 4,
    shadow: 2,
    spacing: 0,
    alignment: 5,
    marginL: 80,
    marginR: 80,
    marginV: { '16:9': 0, '9:16': 0, '1:1': 0 },
    maxChars: { '16:9': 0, '9:16': 0, '1:1': 0 }, // word groups
  },
  lowerthird: {
    latinFont: 'Inter',
    bold: 0,
    sizes: { '16:9': 46, '9:16': 44, '1:1': 44 },
    primary: '&H00E8EBF0',
    secondary: '&H00000000',
    outline: '&H00000000',
    back: '&HB30A0C10',
    borderStyle: 3,
    outlineWidth: 0,
    shadow: 0,
    spacing: 0,
    alignment: 1,
    marginL: 96,
    marginR: 60,
    marginV: { '16:9': 70, '9:16': 180, '1:1': 90 },
    maxChars: { '16:9': 38, '9:16': 24, '1:1': 26 },
  },
  documentary: {
    latinFont: 'Source Serif 4',
    bold: -1,
    sizes: { '16:9': 50, '9:16': 46, '1:1': 48 },
    primary: '&H00F0EDE6',
    secondary: '&H00000000',
    outline: '&HD0000000',
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 2,
    shadow: 1,
    spacing: 1.5,
    alignment: 2,
    marginL: 60,
    marginR: 60,
    marginV: { '16:9': 100, '9:16': 230, '1:1': 120 },
    maxChars: { '16:9': 46, '9:16': 28, '1:1': 30 },
  },
};

// Font per language chosen by the style builder (doc 11) — never system fonts.
export function fontForLanguage(language: string, latinFont: string): string {
  switch (language.split('-')[0]) {
    case 'hi':
      return 'Noto Sans Devanagari';
    case 'ja':
      return 'Noto Sans JP';
    case 'zh':
      return 'Noto Sans SC';
    default:
      return latinFont;
  }
}
