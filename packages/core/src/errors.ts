import type { PipelineStage } from './jobs';

export const ERROR_CODES = [
  'E_ENV',
  'E_LLM_SCHEMA',
  'E_LLM_QUOTA',
  'E_PROVIDER_HTTP',
  'E_QUOTA_PEXELS',
  'E_QUOTA_PIXABAY',
  'E_QUOTA_OPENVERSE',
  'E_QUOTA_NASA',
  'E_QUOTA_WIKIMEDIA',
  'E_QUOTA_WIKIDATA',
  'E_QUOTA_MET',
  'E_QUOTA_INTERNET_ARCHIVE',
  'E_QUOTA_INATURALIST',
  'E_QUOTA_USGS',
  'E_QUOTA_LIBRARY_OF_CONGRESS',
  'E_QUOTA_FLICKR',
  'E_QUOTA_EUROPEANA',
  'E_QUOTA_SMITHSONIAN',
  'E_QUOTA_WELLCOME',
  'E_NO_CANDIDATES',
  'E_TTS_FAIL_BEAT',
  'E_EMBED',
  'E_TEXTCARD',
  'E_ALIGN',
  'E_DOWNLOAD',
  'E_NORMALIZE',
  'E_TIMELINE_INVALID',
  'E_FFMPEG',
  'E_COMPOSE_VERIFY',
  'E_MUSIC',
  'E_SIDECAR_DOWN',
  'E_GEN_MEM',
  'E_DISK_FULL',
  'E_CANCELLED',
  'E_INVARIANT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Retryable codes (doc 18 error table): network, quota-after-window, ffmpeg-once, sidecar-down.
const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'E_LLM_QUOTA',
  'E_PROVIDER_HTTP',
  'E_QUOTA_PEXELS',
  'E_QUOTA_PIXABAY',
  'E_DOWNLOAD',
  'E_FFMPEG',
  'E_SIDECAR_DOWN',
]);

export type ErrorScope = PipelineStage | 'api' | 'worker';

export interface PipelineErrorOpts {
  cause?: unknown;
  beatIdx?: number;
  details?: unknown;
}

export class PipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly stage: ErrorScope,
    message: string,
    readonly opts: PipelineErrorOpts = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PipelineError';
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get beatIdx(): number | undefined {
    return this.opts.beatIdx;
  }
}

// Throws PipelineError('E_INVARIANT') when the condition is falsy (doc 18).
export function invariant(
  condition: unknown,
  message: string,
  stage: ErrorScope = 'worker',
): asserts condition {
  if (!condition) {
    throw new PipelineError('E_INVARIANT', stage, message);
  }
}
