// Canonical Kokoro voice list (doc 10) — 54 voices across 9 language variants,
// derived from the pinned model's VOICES.md. Non-English voices are labelled
// "good" (not flagship) per doc 17's honest UI copy.

export interface Voice {
  id: string;
  language: string; // BCP-ish (en-US, hi, ja, …)
  langCode: string; // Kokoro KPipeline code (a, b, e, f, h, i, p, j, z)
  gender: 'female' | 'male';
  displayName: string;
  quality: 'best' | 'good';
  sampleText: string; // fixed friendly sentence per language (voice preview)
}

interface LangGroup {
  language: string;
  langCode: string;
  quality: 'best' | 'good';
  defaultVoice: string;
  sampleText: string;
  voices: readonly string[];
}

const GROUPS: readonly LangGroup[] = [
  {
    language: 'en-US',
    langCode: 'a',
    quality: 'best',
    defaultVoice: 'af_heart',
    sampleText: 'Hi there — this is a quick preview of how I sound.',
    voices: [
      'af_alloy',
      'af_aoede',
      'af_bella',
      'af_heart',
      'af_jessica',
      'af_kore',
      'af_nicole',
      'af_nova',
      'af_river',
      'af_sarah',
      'af_sky',
      'am_adam',
      'am_echo',
      'am_eric',
      'am_fenrir',
      'am_liam',
      'am_michael',
      'am_onyx',
      'am_puck',
      'am_santa',
    ],
  },
  {
    language: 'en-GB',
    langCode: 'b',
    quality: 'best',
    defaultVoice: 'bf_emma',
    sampleText: 'Hello — here is a short preview of my voice.',
    voices: [
      'bf_alice',
      'bf_emma',
      'bf_isabella',
      'bf_lily',
      'bm_daniel',
      'bm_fable',
      'bm_george',
      'bm_lewis',
    ],
  },
  {
    language: 'es',
    langCode: 'e',
    quality: 'good',
    defaultVoice: 'ef_dora',
    sampleText: 'Hola, esta es una breve muestra de cómo sueno.',
    voices: ['ef_dora', 'em_alex', 'em_santa'],
  },
  {
    language: 'fr',
    langCode: 'f',
    quality: 'good',
    defaultVoice: 'ff_siwis',
    sampleText: 'Bonjour, voici un bref aperçu de ma voix.',
    voices: ['ff_siwis'],
  },
  {
    language: 'hi',
    langCode: 'h',
    quality: 'good',
    defaultVoice: 'hf_alpha',
    sampleText: 'नमस्ते, यह मेरी आवाज़ का एक छोटा नमूना है।',
    voices: ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'],
  },
  {
    language: 'it',
    langCode: 'i',
    quality: 'good',
    defaultVoice: 'if_sara',
    sampleText: 'Ciao, questa è una breve anteprima della mia voce.',
    voices: ['if_sara', 'im_nicola'],
  },
  {
    language: 'pt-BR',
    langCode: 'p',
    quality: 'good',
    defaultVoice: 'pf_dora',
    sampleText: 'Olá, esta é uma breve amostra da minha voz.',
    voices: ['pf_dora', 'pm_alex', 'pm_santa'],
  },
  {
    language: 'ja',
    langCode: 'j',
    quality: 'good',
    defaultVoice: 'jf_alpha',
    sampleText: 'こんにちは、これは私の声の短いサンプルです。',
    voices: ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'],
  },
  {
    language: 'zh',
    langCode: 'z',
    quality: 'good',
    defaultVoice: 'zf_xiaobei',
    sampleText: '你好，这是我声音的简短示例。',
    voices: [
      'zf_xiaobei',
      'zf_xiaoni',
      'zf_xiaoxiao',
      'zf_xiaoyi',
      'zm_yunjian',
      'zm_yunxi',
      'zm_yunxia',
      'zm_yunyang',
    ],
  },
];

function toDisplayName(id: string): string {
  const name = id.split('_')[1] ?? id;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const VOICES: readonly Voice[] = GROUPS.flatMap((group) =>
  group.voices.map(
    (id): Voice => ({
      id,
      language: group.language,
      langCode: group.langCode,
      gender: id[1] === 'f' ? 'female' : 'male',
      displayName: toDisplayName(id),
      quality: group.quality,
      sampleText: group.sampleText,
    }),
  ),
);

export const DEFAULT_VOICE_ID = 'af_heart';

const VOICE_BY_ID = new Map(VOICES.map((voice) => [voice.id, voice]));

export function voiceById(id: string): Voice | undefined {
  return VOICE_BY_ID.get(id);
}

export function langCodeForVoice(id: string): string | undefined {
  return VOICE_BY_ID.get(id)?.langCode;
}

export function defaultVoiceForLanguage(language: string): Voice | undefined {
  const group = GROUPS.find((g) => g.language === language);
  return group ? voiceById(group.defaultVoice) : undefined;
}
