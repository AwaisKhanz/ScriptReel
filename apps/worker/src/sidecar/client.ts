import { env } from '@scriptreel/config';
import { PipelineError } from '@scriptreel/core';
import { z } from 'zod';

// Typed client for the ML sidecar (doc 14). Responses are zod-validated (doc 18).
const TtsResponseSchema = z.object({ path: z.string(), durationSec: z.number() });
export type TtsResponse = z.infer<typeof TtsResponseSchema>;

const SidecarErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export interface TtsParams {
  text: string;
  voice: string;
  langCode: string;
  speed: number;
  outPath: string;
}

export async function ttsSynthesize(params: TtsParams, signal?: AbortSignal): Promise<TtsResponse> {
  let res: Response;
  try {
    res = await fetch(`${env.SIDECAR_URL}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw new PipelineError(
      'E_SIDECAR_DOWN',
      'tts',
      `sidecar unreachable at ${env.SIDECAR_URL} — start it with \`pnpm sidecar\``,
      { cause },
    );
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const parsed = SidecarErrorSchema.safeParse(body);
    throw new Error(
      parsed.success
        ? `${parsed.data.error.code}: ${parsed.data.error.message}`
        : `sidecar /tts → HTTP ${res.status}`,
    );
  }
  const json: unknown = await res.json();
  const parsed = TtsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('sidecar /tts returned an unexpected shape');
  }
  return parsed.data;
}

const AlignResponseSchema = z.object({
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
});
export type AlignResult = z.infer<typeof AlignResponseSchema>;

export interface AlignParams {
  audioPath: string;
  language: string;
  text: string;
}

export async function alignAudio(params: AlignParams, signal?: AbortSignal): Promise<AlignResult> {
  let res: Response;
  try {
    res = await fetch(`${env.SIDECAR_URL}/align`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw new PipelineError(
      'E_SIDECAR_DOWN',
      'align',
      `sidecar unreachable at ${env.SIDECAR_URL}`,
      {
        cause,
      },
    );
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const parsed = SidecarErrorSchema.safeParse(body);
    throw new PipelineError(
      'E_ALIGN',
      'align',
      parsed.success
        ? `${parsed.data.error.code}: ${parsed.data.error.message}`
        : `sidecar /align → HTTP ${res.status}`,
    );
  }
  const json: unknown = await res.json();
  const parsed = AlignResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PipelineError('E_ALIGN', 'align', 'sidecar /align returned an unexpected shape');
  }
  return parsed.data;
}

const EmbedTextResponseSchema = z.object({
  vectors: z.array(z.array(z.number())),
  dim: z.number(),
});
export type EmbedTextResult = z.infer<typeof EmbedTextResponseSchema>;

const EmbedImageResponseSchema = z.object({
  vectors: z.array(z.array(z.number())),
  dim: z.number(),
  failed: z.array(z.string()),
});
export type EmbedImageResult = z.infer<typeof EmbedImageResponseSchema>;

async function postSidecar<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.SIDECAR_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    throw new PipelineError(
      'E_SIDECAR_DOWN',
      'score',
      `sidecar unreachable at ${env.SIDECAR_URL}`,
      {
        cause,
      },
    );
  }
  if (!res.ok) {
    const errBody: unknown = await res.json().catch(() => ({}));
    const parsedErr = SidecarErrorSchema.safeParse(errBody);
    throw new PipelineError(
      'E_EMBED',
      'score',
      parsedErr.success
        ? `${parsedErr.data.error.code}: ${parsedErr.data.error.message}`
        : `sidecar ${path} → HTTP ${res.status}`,
    );
  }
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new PipelineError('E_EMBED', 'score', `sidecar ${path} returned an unexpected shape`);
  }
  return parsed.data;
}

export function embedText(texts: string[], signal?: AbortSignal): Promise<EmbedTextResult> {
  return postSidecar('/embed/text', { texts }, EmbedTextResponseSchema, signal);
}

export function embedImage(paths: string[], signal?: AbortSignal): Promise<EmbedImageResult> {
  return postSidecar('/embed/image', { paths }, EmbedImageResponseSchema, signal);
}
