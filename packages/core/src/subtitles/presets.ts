// ASS style presets — canonical params from doc 17 §subtitle presets. Colors are
// ASS &HAABBGGRR (AA=00 opaque). PlayRes is always 1920×1080; libass scales.

export type SubtitlePreset = 'clean' | 'pop' | 'lowerthird' | 'documentary';
export type SubtitleAspect = '16:9' | '9:16' | '1:1';

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
  alignment: number; // 2 bottom, 5 middle, 8 top
  marginL: number;
  marginR: number;
  marginV: number;
  maxCharsPerLine: number; // 0 = word groups (pop)
}

export const PRESETS: Record<SubtitlePreset, PresetSpec> = {
  clean: {
    latinFont: 'Inter',
    bold: -1,
    sizes: { '16:9': 54, '9:16': 62, '1:1': 58 },
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
    marginV: 90,
    maxCharsPerLine: 42,
  },
  pop: {
    latinFont: 'Inter',
    bold: -1,
    sizes: { '16:9': 76, '9:16': 92, '1:1': 84 },
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
    marginV: 0,
    maxCharsPerLine: 0,
  },
  lowerthird: {
    latinFont: 'Inter',
    bold: 0,
    sizes: { '16:9': 46, '9:16': 54, '1:1': 50 },
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
    marginV: 70,
    maxCharsPerLine: 38,
  },
  documentary: {
    latinFont: 'Source Serif 4',
    bold: -1,
    sizes: { '16:9': 50, '9:16': 58, '1:1': 54 },
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
    marginV: 100,
    maxCharsPerLine: 46,
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
