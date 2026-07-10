import { z } from 'zod';
import { hashObject } from './hash';
import { DEFAULT_VOICE_ID } from './voices';

// Every user-facing control (doc 02). Persisted per-project in projects.settings
// (jsonb) and validated here. Changing a field invalidates only the stages that
// consume it (doc 06 §Invalidation).
export const ASPECTS = ['16:9', '9:16', '1:1'] as const;
export const QUALITIES = ['draft', 'final'] as const;
export const PACINGS = ['fast', 'normal', 'slow'] as const;
export const MEDIA_PREFERENCES = ['videos', 'mixed', 'photos'] as const;
export const TRANSITION_STYLES = ['crossfade', 'cut', 'smart'] as const;
export const SUBTITLE_PRESETS = ['clean', 'pop', 'lowerthird', 'documentary', 'none'] as const;
export const SUBTITLE_POSITIONS = ['bottom', 'middle', 'top'] as const;
export const MUSIC_MOODS = [
  'none',
  'uplifting',
  'calm',
  'corporate',
  'emotional',
  'energetic',
  'tense',
  'auto',
] as const;
export const LANGUAGES = ['en-US', 'en-GB', 'es', 'fr', 'hi', 'it', 'pt-BR', 'ja', 'zh'] as const;

export const ProjectSettingsSchema = z.object({
  // voice & narration
  voice: z.string().min(1).default(DEFAULT_VOICE_ID),
  speed: z.number().min(0.8).max(1.3).default(1.0),
  pauseMs: z.number().int().min(0).max(600).default(150),
  // format & quality
  aspect: z.enum(ASPECTS).default('16:9'),
  quality: z.enum(QUALITIES).default('final'),
  // visuals & pacing
  pacing: z.enum(PACINGS).default('normal'),
  mediaPreference: z.enum(MEDIA_PREFERENCES).default('mixed'),
  transitionStyle: z.enum(TRANSITION_STYLES).default('smart'),
  crossfadeSec: z.number().min(0.3).max(0.6).default(0.4),
  allowGenerated: z.boolean().default(false),
  reviewBeforeRender: z.boolean().default(true),
  // subtitles
  subtitlePreset: z.enum(SUBTITLE_PRESETS).default('clean'),
  subtitlePosition: z.enum(SUBTITLE_POSITIONS).default('bottom'),
  // music
  musicMood: z.enum(MUSIC_MOODS).default('auto'),
  musicTrackId: z.string().optional(),
  musicLevelDb: z.number().min(-24).max(-10).default(-16),
  // language pre-select (analyze auto-detects when omitted)
  language: z.enum(LANGUAGES).optional(),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export function defaultSettings(): ProjectSettings {
  return ProjectSettingsSchema.parse({});
}

export function parseSettings(input: unknown): ProjectSettings {
  return ProjectSettingsSchema.parse(input);
}

// sha1 of normalized settings (doc 05 projects.settings_hash).
export function settingsHash(settings: ProjectSettings): string {
  return hashObject(ProjectSettingsSchema.parse(settings));
}
