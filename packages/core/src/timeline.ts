import { z } from 'zod';
import { FRAME_SEC } from './constants';
import { PipelineError } from './errors';

// THE CONTRACT (doc 12). This zod schema is the source of truth; the composer
// consumes only a validated Timeline + local paths — no DB, no AI, no network.

const KenBurnsSchema = z.object({
  direction: z.enum(['in-tl', 'in-br', 'out-tr', 'out-bl']),
  zoomFrom: z.number(),
  zoomTo: z.number(),
});

const MediaBase = {
  path: z.string().min(1),
  provider: z.string().optional(),
  providerId: z.string().optional(),
  author: z.string().optional(),
  pageUrl: z.string().optional(),
};

const VideoMediaSchema = z.object({
  ...MediaBase,
  kind: z.literal('video'),
  sourceDurationSec: z.number().optional(),
  inPointSec: z.number().optional(),
});

const StillMediaSchema = z.object({
  ...MediaBase,
  kind: z.enum(['image', 'generated', 'textcard']),
  kenburns: KenBurnsSchema, // REQUIRED for stills (doc 12)
});

const MediaSchema = z.discriminatedUnion('kind', [VideoMediaSchema, StillMediaSchema]);

const TimelineBeatSchema = z.object({
  idx: z.number().int().nonnegative(),
  text: z.string(),
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  media: MediaSchema,
});

export const TimelineSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  createdAt: z.string(),
  render: z.object({
    aspect: z.enum(['16:9', '9:16', '1:1']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.literal(30),
    preset: z.enum(['draft', 'final']),
  }),
  narration: z.object({
    audioPath: z.string().min(1),
    durationSec: z.number().positive(),
  }),
  music: z.union([
    z.null(),
    z.object({
      path: z.string(),
      gainDb: z.number(),
      fadeOutSec: z.number(),
      credit: z.string(),
    }),
  ]),
  subtitles: z.union([
    z.null(),
    z.object({
      assPath: z.string(),
      preset: z.enum(['clean', 'pop', 'lowerthird', 'documentary']),
    }),
  ]),
  beats: z.array(TimelineBeatSchema).min(1),
  transitions: z.object({
    default: z.enum(['crossfade', 'cut']),
    crossfadeSec: z.number(),
    perBoundary: z.array(z.enum(['crossfade', 'cut'])).optional(),
  }),
  credits: z.object({ text: z.string() }),
});

export type Timeline = z.infer<typeof TimelineSchema>;
export type TimelineBeat = Timeline['beats'][number];

const EPS = FRAME_SEC / 2;

// Composer MUST call this before rendering (doc 12 §Invariants). Any violation
// throws PipelineError('E_TIMELINE_INVALID').
export function assertTimelineInvariants(timeline: Timeline): void {
  const fail = (message: string): never => {
    throw new PipelineError('E_TIMELINE_INVALID', 'compose', message);
  };

  const parsed = TimelineSchema.safeParse(timeline);
  if (!parsed.success) {
    fail(`schema: ${parsed.error.issues[0]?.message ?? 'invalid timeline'}`);
  }

  const { beats, narration, transitions } = timeline;

  if (beats[0]?.startSec !== 0) {
    fail('beats[0].startSec must be 0');
  }

  let sum = 0;
  for (const [i, beat] of beats.entries()) {
    // invariant 2: frame-quantized durations
    const frames = beat.durationSec / FRAME_SEC;
    if (Math.abs(frames - Math.round(frames)) > 1e-6) {
      fail(`beat ${i} durationSec is not frame-quantized`);
    }
    // invariant 1: contiguity
    if (i > 0) {
      const prev = beats[i - 1];
      if (prev && Math.abs(beat.startSec - (prev.startSec + prev.durationSec)) > EPS) {
        fail(`beat ${i} is not contiguous with beat ${i - 1}`);
      }
    }
    sum += beat.durationSec;
  }

  // invariant 1: Σ durations === narration ± 1/30 s
  if (Math.abs(sum - narration.durationSec) > FRAME_SEC + 1e-6) {
    fail(`Σ beat durations (${sum}) != narration (${narration.durationSec})`);
  }

  // invariant 4: perBoundary length === beats.length - 1
  if (transitions.perBoundary && transitions.perBoundary.length !== beats.length - 1) {
    fail('transitions.perBoundary length must equal beats.length - 1');
  }
}
