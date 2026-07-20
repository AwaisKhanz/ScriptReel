import { env } from '@scriptreel/config';
import { PipelineError } from '@scriptreel/core';
import { z } from 'zod';
import type { TtsParams, TtsResponse } from '../sidecar/client';

// Client for the isolated Chatterbox voice server (services/voice). It speaks the exact same /tts
// contract as the sidecar ({ text, voice, langCode, speed, outPath } → { path, durationSec },
// 24 kHz PCM_16), so the tts stage treats it as an interchangeable backend selected per-voice.
const TtsResponseSchema = z.object({ path: z.string(), durationSec: z.number() });
const VoiceErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

// A cold first request loads Chatterbox on the GPU (~20–40 s) before it can synthesise, and
// generation is serialised server-side — so give it a longer ceiling than the sidecar's 120 s.
const TTS_TIMEOUT_MS = 180_000;

function reqSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function chatterboxSynthesize(
  params: TtsParams,
  signal?: AbortSignal,
): Promise<TtsResponse> {
  let res: Response;
  try {
    res = await fetch(`${env.CHATTERBOX_URL}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: reqSignal(signal, TTS_TIMEOUT_MS),
    });
  } catch (cause) {
    if (signal?.aborted) throw new PipelineError('E_CANCELLED', 'tts', 'cancelled', { cause });
    // Reuse E_SIDECAR_DOWN so the retry semantics match a down sidecar (the tts stage rethrows it
    // and pg-boss retries the job once the server is back) — only the message names the real server.
    throw new PipelineError(
      'E_SIDECAR_DOWN',
      'tts',
      `voice server unreachable at ${env.CHATTERBOX_URL} — start it with \`pnpm --filter @scriptreel/voice dev\``,
      { cause },
    );
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const parsed = VoiceErrorSchema.safeParse(body);
    throw new Error(
      parsed.success
        ? `${parsed.data.error.code}: ${parsed.data.error.message}`
        : `voice server /tts → HTTP ${res.status}`,
    );
  }
  const json: unknown = await res.json();
  const parsed = TtsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('voice server /tts returned an unexpected shape');
  }
  return parsed.data;
}
