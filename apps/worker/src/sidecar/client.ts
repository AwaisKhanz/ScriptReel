import { env } from '@scriptreel/config';
import { PipelineError } from '@scriptreel/core';
import { z } from 'zod';

// Typed client for the ML sidecar (doc 14). Responses are zod-validated (doc 18).
const TtsResponseSchema = z.object({ path: z.string(), durationSec: z.number() });
export type TtsResponse = z.infer<typeof TtsResponseSchema>;

const SidecarErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

// A wedged sidecar (e.g. after many hours) must not hang a stage forever. Bound
// every request with a timeout, combined with the caller's cancel signal. On
// timeout fetch throws → surfaces as a retryable E_SIDECAR_DOWN so pg-boss retries
// once the sidecar recovers, instead of the job sitting at 0% indefinitely.
function reqSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
      signal: reqSignal(signal, 120_000),
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
      signal: reqSignal(signal, 120_000),
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
  timeoutMs: number,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.SIDECAR_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: reqSignal(signal, timeoutMs),
    });
  } catch (cause) {
    // Three different things reach this catch and they are NOT the same error.
    //
    // `reqSignal` merges the caller's cancel signal with a timeout, so an abort here means either
    // "the user pressed Cancel" or "the sidecar was too slow" — and a genuine connection failure
    // means the sidecar is actually down. Reporting all three as E_SIDECAR_DOWN told the user
    // "sidecar unreachable at 127.0.0.1:8484" seconds after /health had answered 200 OK, for a
    // cancel they themselves had just clicked. An error that names the wrong culprit is worse than
    // no error: it sends you debugging a service that was never broken.
    if (signal?.aborted) throw new PipelineError('E_CANCELLED', 'score', 'cancelled', { cause });
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new PipelineError(
      'E_SIDECAR_DOWN',
      'score',
      timedOut
        ? `sidecar at ${env.SIDECAR_URL} did not respond within ${Math.round(timeoutMs / 1000)}s (it is running — the model is loading or the GPU is busy)`
        : `sidecar unreachable at ${env.SIDECAR_URL}`,
      { cause },
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
  return postSidecar('/embed/text', { texts }, EmbedTextResponseSchema, signal, 90_000);
}

export function embedImage(paths: string[], signal?: AbortSignal): Promise<EmbedImageResult> {
  return postSidecar('/embed/image', { paths }, EmbedImageResponseSchema, signal, 90_000);
}

// Reference-identity embeds (doc 25 §5-C, cascade C). InsightFace face vectors and DINOv2
// image vectors share the /embed/image response shape ({ vectors, dim, failed }). Either
// endpoint throws E_FACE_UNAVAILABLE / E_DINO_UNAVAILABLE (or E_SIDECAR_DOWN / timeout)
// when its model is absent — the identity pass catches that, skips the whole gate, and
// leaves selection unchanged (invariant 7).
export function faceEmbed(paths: string[], signal?: AbortSignal): Promise<EmbedImageResult> {
  return postSidecar('/face/embed', { paths }, EmbedImageResponseSchema, signal, 90_000);
}

export function dinoEmbed(paths: string[], signal?: AbortSignal): Promise<EmbedImageResult> {
  return postSidecar('/dino/embed', { paths }, EmbedImageResponseSchema, signal, 90_000);
}

// VLM checklist gate (doc 25 §5-D, cascade D). Qwen2.5-VL judges each item's image
// against the beat's description + era, returning four bools per readable image; images
// it couldn't read / parse land in `failed`. The model is loaded on demand (mlx ~2.2 GB on
// Apple; a q8 Ollama VLM is ~10 GB), and the remote (Ollama) path processes the batch
// SERIALLY, each item bounded by the sidecar's VLM_TIMEOUT_S (code default 300 s; .env sets
// 120). The client budget is computed per batch at the `vlm()` call below — see the note there
// for why a fixed one silently skips the gate on any real script. A missing model
// throws E_VLM_UNAVAILABLE (or E_SIDECAR_DOWN / timeout) — the VLM pass catches that, skips
// the whole gate, and leaves selection unchanged (invariant 7).
const VlmChecklistSchema = z.object({
  path: z.string(),
  subjectPresent: z.boolean(),
  shotTypeMatches: z.boolean(),
  eraMatches: z.boolean(),
  contradictingText: z.boolean(),
});
export type VlmChecklistItem = z.infer<typeof VlmChecklistSchema>;

const VlmResponseSchema = z.object({
  results: z.array(VlmChecklistSchema),
  failed: z.array(z.string()),
});
export type VlmResponse = z.infer<typeof VlmResponseSchema>;

export interface VlmItem {
  path: string;
  description: string;
  era: string;
}

// The batch is ONE deduped list across ALL beats (pipeline/vlm.ts builds `itemByPath` over every
// beat, then issues a single call), so its size is VLM_TOP_K × beats — NOT VLM_TOP_K. A fixed
// budget therefore silently under-covers any real script: measured on G9, 15 beats ⇒ ~45 items
// against 420 s is 9 s/item, and one cold load of a ~10 GB q8 vision model can spend a third of
// that before the first item is scored. On a timeout the gate is skipped wholesale (invariant 7)
// and every second of GPU work already done is discarded — the exact silent-no-op that raising
// the sidecar's own per-item timeout (24aeed8) was meant to end. So scale with the batch, and
// keep the old value as a floor for small ones.
const VLM_MS_PER_ITEM = 20_000; // ~4× the warm per-item cost; the sidecar caps each at VLM_TIMEOUT_S
const VLM_LOAD_MARGIN_MS = 120_000; // evict + load of a multi-GB model before item 1

export function vlm(items: VlmItem[], signal?: AbortSignal): Promise<VlmResponse> {
  const budgetMs = Math.max(420_000, items.length * VLM_MS_PER_ITEM + VLM_LOAD_MARGIN_MS);
  return postSidecar('/vlm', { items }, VlmResponseSchema, signal, budgetMs);
}

// OCR gate (doc 25 §5): Tesseract reads burned-in text/coverage for a beat's SigLIP
// shortlist. Tesseract may be absent — this call throws E_OCR_UNAVAILABLE (or times
// out / E_SIDECAR_DOWN) and the score stage catches it to skip the gate (invariant 7).
const OcrItemSchema = z.object({
  path: z.string(),
  text: z.string(),
  coverage: z.number(),
  wordCount: z.number(),
});
export type OcrItem = z.infer<typeof OcrItemSchema>;

const OcrResponseSchema = z.object({
  results: z.array(OcrItemSchema),
  failed: z.array(z.string()),
});
export type OcrResponse = z.infer<typeof OcrResponseSchema>;

export function ocr(paths: string[], signal?: AbortSignal): Promise<OcrResponse> {
  return postSidecar('/ocr', { paths }, OcrResponseSchema, signal, 60_000);
}

const TextcardResponseSchema = z.object({ path: z.string() });
export type TextcardResult = z.infer<typeof TextcardResponseSchema>;

export interface TextcardParams {
  phrase: string;
  emotion: string;
  aspect: string;
  theme: string;
  outPath: string;
}

export function renderTextcard(
  params: TextcardParams,
  signal?: AbortSignal,
): Promise<TextcardResult> {
  return postSidecar('/textcard', params, TextcardResponseSchema, signal, 60_000);
}
