// Stub — Phase 3 populates the full 54-voice Kokoro table from the pinned model
// revision (doc 10). Kept minimal so settings.ts can default a voice now.

export interface Voice {
  id: string;
  label: string;
  lang: string; // BCP-ish (en-US, hi, ja, …)
  quality: 'best' | 'good';
}

export const DEFAULT_VOICE_ID = 'af_heart';

export const VOICES: readonly Voice[] = [
  { id: 'af_heart', label: 'Heart', lang: 'en-US', quality: 'best' },
];
