import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  type BuildBeatInput,
  buildTimeline,
  clipPlan,
  FRAME_SEC,
  hashObject,
  invariant,
  type MotionSample,
  PipelineError,
  type Timeline,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pLimit from 'p-limit';
import { ensureDiskSpace } from '../cache/disk-guard';
import { analyzeMotion } from '../ffmpeg/motion';
import { concatClips, normalizeStill, normalizeVideo } from '../ffmpeg/normalize';
import { probeAudio, probeVideo } from '../ffmpeg/probe';
import { downloadToCache } from '../providers/download';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

const DOWNLOAD_PARALLELISM = 3;
const NORMALIZE_PARALLELISM = 3;

function dimsFor(aspect: string): [number, number] {
  if (aspect === '9:16') return [1080, 1920];
  if (aspect === '1:1') return [1080, 1080];
  return [1920, 1080];
}

interface ResolvedSource {
  kind: 'video' | 'image' | 'generated' | 'textcard';
  path: string; // local
  sourceDurationSec?: number;
  motionSamples?: MotionSample[]; // per-frame motion for best-window in-point (doc 23 §7)
}

// The candidate fields resolveMedia needs — shared by the chosen row and montage
// segment candidate rows.
interface MediaSpec {
  provider: string;
  providerId: string;
  kind: string;
  remoteUrl: string | null;
  thumbPath: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  license: string | null;
  author: string | null;
  pageUrl: string | null;
}

// beats.segments (doc 23 §7): ordered [{candidateId, weight}]; anything else ⇒ single.
function parseSegmentPlan(raw: unknown): { candidateId: string; weight: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { candidateId: string; weight: number }[] = [];
  for (const it of raw) {
    if (
      it &&
      typeof it === 'object' &&
      typeof (it as { candidateId?: unknown }).candidateId === 'string'
    ) {
      const w = Number((it as { weight?: unknown }).weight);
      out.push({ candidateId: (it as { candidateId: string }).candidateId, weight: w > 0 ? w : 1 });
    }
  }
  return out;
}

// A resolved visual as build-timeline input media (video carries window signals).
function toBuildMedia(s: ResolvedSource): BuildBeatInput['media'] {
  return s.kind === 'video'
    ? {
        kind: 'video',
        path: s.path,
        ...(s.sourceDurationSec !== undefined ? { sourceDurationSec: s.sourceDurationSec } : {}),
        ...(s.motionSamples ? { motionSamples: s.motionSamples } : {}),
      }
    : { kind: s.kind, path: s.path };
}

// Normalize one visual (video window or Ken Burns still) to a uniform clip of `lengthSec`.
async function normalizeOne(
  media: Timeline['beats'][number]['media'],
  lengthSec: number,
  headPadSec: number,
  dims: { width: number; height: number },
  outPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (media.kind === 'video') {
    await normalizeVideo({
      src: media.path,
      inPointSec: media.inPointSec ?? 0,
      headPadSec,
      lengthSec,
      sourceDurationSec: media.sourceDurationSec ?? lengthSec,
      width: dims.width,
      height: dims.height,
      outPath,
      signal,
    });
  } else {
    await normalizeStill({
      src: media.path,
      kenburns: media.kenburns,
      lengthSec,
      width: dims.width,
      height: dims.height,
      outPath,
      signal,
    });
  }
}

// Render a beat's clip: a single visual, or — for a montage beat (doc 23 §7) — each
// segment normalized to a sub-clip and concatenated. The crossfade pads live only at
// the beat's outer edges, so they attach to the first (head) and last (tail) segment;
// internal boundaries are exact hard cuts. compose still sees one clip per beat.
async function renderBeatClip(
  beat: Timeline['beats'][number],
  entry: { lengthSec: number; headPadSec: number },
  dims: { width: number; height: number },
  clipsDir: string,
  signal: AbortSignal,
): Promise<void> {
  const outPath = join(clipsDir, `${beat.idx}.mp4`);
  if (!beat.segments) {
    await normalizeOne(beat.media, entry.lengthSec, entry.headPadSec, dims, outPath, signal);
    return;
  }
  const headPad = entry.headPadSec;
  const tailPad = entry.lengthSec - beat.durationSec - entry.headPadSec;
  const temps: string[] = [];
  try {
    for (let k = 0; k < beat.segments.length; k += 1) {
      const seg = beat.segments[k];
      if (!seg) continue;
      const isFirst = k === 0;
      const isLast = k === beat.segments.length - 1;
      const lengthSec = seg.durationSec + (isFirst ? headPad : 0) + (isLast ? tailPad : 0);
      const dst = join(clipsDir, `${beat.idx}.seg${k}.mp4`);
      temps.push(dst);
      await normalizeOne(seg.media, lengthSec, isFirst ? headPad : 0, dims, dst, signal);
    }
    await concatClips(temps, outPath, signal);
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true }).catch(() => {})));
  }
}

// fetch stage (doc 13 Pass A): download every chosen asset (shared asset_cache),
// build the timeline for the padded clip lengths, and normalize each beat into a
// uniform W×H@30 silent clip. Degrades on download/normalize failure (doc 07 inv 7).
export const fetchStage: Stage = {
  name: 'fetch',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const media = await db.getChosenMedia(ctx.projectId);
    return hashObject({
      stage: 'fetch',
      chosen: media.map((m) => [
        m.idx,
        m.provider,
        m.providerId,
        m.kind,
        (m.narration as { durationSec?: number } | null)?.durationSec ?? 0,
        JSON.stringify(m.segments ?? null), // montage plan (doc 23 §7)
      ]),
      aspect: ctx.settings.aspect,
      quality: ctx.settings.quality,
      pauseMs: ctx.settings.pauseMs,
      transitionStyle: ctx.settings.transitionStyle,
      crossfadeSec: ctx.settings.crossfadeSec,
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    await ensureDiskSpace('fetch', ctx.log); // guard + LRU cache eviction (doc 14)
    const media = await db.getChosenMedia(ctx.projectId);
    invariant(media.length > 0, 'no chosen media — run score first', 'fetch');
    const project = await db.getProject(ctx.projectId);
    invariant(project, `project ${ctx.projectId} not found`, 'fetch');

    const { aspect, quality, transitionStyle, crossfadeSec, pauseMs } = ctx.settings;
    const [width, height] = dimsFor(aspect);

    // 1) Resolve every source to a local path (download video/image; stills are local).
    report(5, 'downloading assets');
    const dlLimit = pLimit(DOWNLOAD_PARALLELISM);
    const warnings: string[] = [];
    let downloads = 0;
    // Download + probe + (video) motion-sample one media spec; null on failure (degrade).
    const resolveMedia = async (
      spec: MediaSpec,
      beatIdx: number,
    ): Promise<ResolvedSource | null> => {
      if (ctx.signal.aborted) throw new PipelineError('E_CANCELLED', 'fetch', 'cancelled');
      try {
        if (spec.kind === 'video' || spec.kind === 'image') {
          const row = await downloadToCache(
            {
              provider: spec.provider,
              providerId: spec.providerId,
              kind: spec.kind,
              remoteUrl: spec.remoteUrl ?? '',
              ...(spec.width != null ? { width: Number(spec.width) } : {}),
              ...(spec.height != null ? { height: Number(spec.height) } : {}),
              ...(spec.duration != null ? { duration: Number(spec.duration) } : {}),
              ...(spec.license != null ? { license: spec.license } : {}),
              ...(spec.author != null ? { author: spec.author } : {}),
              ...(spec.pageUrl != null ? { pageUrl: spec.pageUrl } : {}),
            },
            ctx.signal,
          );
          downloads += 1;
          // Live activity event (doc 16): asset landed (downloads climb 5% → 18%).
          report(
            Math.min(18, 5 + downloads),
            JSON.stringify({
              op: 'download',
              provider: spec.provider,
              kind: spec.kind,
              n: downloads,
            }),
          );
          if (spec.kind === 'video') {
            const probe = await probeVideo(row.local_path);
            const motionSamples =
              probe.durationSec > 0
                ? await analyzeMotion(row.local_path, ctx.signal).catch((err) => {
                    ctx.log.warn(
                      { err, beat: beatIdx },
                      'motion analysis failed — geometric in-point',
                    );
                    return [] as MotionSample[];
                  })
                : [];
            return {
              kind: 'video',
              path: row.local_path,
              sourceDurationSec: probe.durationSec,
              ...(motionSamples.length > 0 ? { motionSamples } : {}),
            };
          }
          return { kind: 'image', path: row.local_path };
        }
        const local = spec.thumbPath ?? spec.remoteUrl ?? '';
        return { kind: spec.kind === 'generated' ? 'generated' : 'textcard', path: local };
      } catch (err) {
        if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
        warnings.push(
          `E_DOWNLOAD: beat ${beatIdx} (${spec.provider}:${spec.providerId}) — falling back`,
        );
        ctx.log.warn({ err, beat: beatIdx }, 'download failed');
        return null;
      }
    };

    // The chosen visual per beat (montage segment 0), plus every extra montage segment
    // candidate (doc 23 §7). downloadToCache dedupes, so shared assets cost one fetch.
    const sources = await Promise.all(media.map((m) => dlLimit(() => resolveMedia(m, m.idx))));
    const extraIds = [
      ...new Set(
        media.flatMap((m) =>
          parseSegmentPlan(m.segments)
            .slice(1)
            .map((p) => p.candidateId),
        ),
      ),
    ];
    const extraRows = extraIds.length > 0 ? await db.getCandidateMedia(extraIds) : [];
    const extraById = new Map<string, ResolvedSource | null>();
    await Promise.all(
      extraRows.map((row) =>
        dlLimit(async () => extraById.set(row.id, await resolveMedia(row, -1))),
      ),
    );
    invariant(
      sources.some((s) => s !== null),
      'every asset download failed — cannot compose',
      'fetch',
    );

    // 2) Build the timeline for the padded clip lengths (narration is the clock).
    const voPath = join(paths.projectDir(ctx.projectId), 'audio', 'vo.wav');
    const voProbe = await probeAudio(voPath);
    const beatsInput: BuildBeatInput[] = [];
    for (let i = 0; i < media.length; i += 1) {
      const m = media[i];
      const src = sources[i];
      if (!m || !src) continue; // a failed download drops the beat from the render
      const narrationDurationSec =
        (m.narration as { durationSec?: number } | null)?.durationSec ?? 0;
      const beatMedia = toBuildMedia(src);

      // Montage: segment 0 is the chosen (src); the rest resolve from extraById. A
      // segment whose download failed is dropped; <2 survivors ⇒ single visual.
      const plan = parseSegmentPlan(m.segments);
      let segments: NonNullable<BuildBeatInput['segments']> | undefined;
      if (plan.length > 1) {
        const first = plan[0];
        const visuals: NonNullable<BuildBeatInput['segments']> = [
          { media: beatMedia, weight: first?.weight ?? 1 },
        ];
        for (let k = 1; k < plan.length; k += 1) {
          const p = plan[k];
          const ex = p ? extraById.get(p.candidateId) : null;
          if (ex) visuals.push({ media: toBuildMedia(ex), weight: p?.weight ?? 1 });
        }
        if (visuals.length > 1) segments = visuals;
      }

      beatsInput.push({
        idx: m.idx,
        text: m.text,
        narrationDurationSec,
        ...(m.shotType ? { shotType: m.shotType } : {}),
        ...(m.emotion ? { emotion: m.emotion } : {}),
        media: beatMedia,
        ...(segments ? { segments } : {}),
      });
    }

    const timeline: Timeline = buildTimeline({
      projectId: ctx.projectId,
      createdAt: new Date(project.created_at).toISOString(),
      render: { aspect, width, height, preset: quality === 'draft' ? 'draft' : 'final' },
      narration: { audioPath: voPath, durationSec: voProbe.durationSec },
      beats: beatsInput,
      pauseSec: pauseMs / 1000,
      transitions: { style: transitionStyle, crossfadeSec },
      music: null,
      subtitles: null,
      credits: '',
    });
    const plan = clipPlan(timeline);

    // 3) Normalize each beat → clips/{idx}.mp4 (parallelism 3).
    const clipsDir = join(paths.projectDir(ctx.projectId), 'clips');
    await mkdir(clipsDir, { recursive: true });
    const normLimit = pLimit(NORMALIZE_PARALLELISM);
    let done = 0;
    await Promise.all(
      timeline.beats.map((beat, i) =>
        normLimit(async () => {
          if (ctx.signal.aborted) throw new PipelineError('E_CANCELLED', 'fetch', 'cancelled');
          const entry = plan[i];
          invariant(entry, `clip plan missing for beat ${beat.idx}`, 'fetch');
          await renderBeatClip(beat, entry, { width, height }, clipsDir, ctx.signal);
          done += 1;
          report(
            20 + Math.round((70 * done) / timeline.beats.length),
            JSON.stringify({ op: 'normalize', beat: done, of: timeline.beats.length }),
          );
        }),
      ),
    );

    // 4) Assert every clip's geometry / fps / length (doc 13 exit criteria).
    report(95, 'verifying clips');
    for (let i = 0; i < timeline.beats.length; i += 1) {
      const beat = timeline.beats[i];
      const entry = plan[i];
      if (!beat || !entry) continue;
      const outPath = join(clipsDir, `${beat.idx}.mp4`);
      const probe = await probeVideo(outPath);
      invariant(
        probe.width === width && probe.height === height,
        `clip ${beat.idx} geometry ${probe.width}x${probe.height} != ${width}x${height}`,
        'fetch',
      );
      invariant(Math.abs(probe.fps - 30) < 1, `clip ${beat.idx} fps ${probe.fps} != 30`, 'fetch');
      invariant(
        probe.durationSec >= entry.lengthSec - FRAME_SEC - 1e-3,
        `clip ${beat.idx} duration ${probe.durationSec.toFixed(3)} < required ${entry.lengthSec.toFixed(3)}`,
        'fetch',
      );
    }

    report(100, `${timeline.beats.length} clips normalized`);
    return {
      artifacts: timeline.beats.map((b) => `clips/${b.idx}.mp4`),
      warnings,
      meta: {
        clips: timeline.beats.length,
        downloads,
        width,
        height,
        stills: timeline.beats.filter((b) => b.media.kind !== 'video').length,
      },
    };
  },
};
