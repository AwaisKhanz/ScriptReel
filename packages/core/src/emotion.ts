import type { Emotion } from './analysis';

// Emotion → text-card theme (doc 17 §Text-card themes). Theme colors live in
// assets/brand/textcard-themes.json (read by the sidecar); this maps the analyzer's
// emotion set (doc 07) onto the five themes. Unmapped emotions fall back to neutral.
export const TEXTCARD_THEMES = ['neutral', 'uplifting', 'calm', 'tense', 'corporate'] as const;
export type TextcardTheme = (typeof TEXTCARD_THEMES)[number];

const EMOTION_THEME: Record<Emotion, TextcardTheme> = {
  neutral: 'neutral',
  uplifting: 'uplifting',
  serious: 'corporate',
  tense: 'tense',
  sad: 'calm', // no dedicated sad theme — cool/subdued reads closer than the alarm red of tense
  exciting: 'uplifting',
  calm: 'calm',
  inspiring: 'uplifting',
};

export function themeForEmotion(emotion: string): TextcardTheme {
  return (EMOTION_THEME as Record<string, TextcardTheme>)[emotion] ?? 'neutral';
}
