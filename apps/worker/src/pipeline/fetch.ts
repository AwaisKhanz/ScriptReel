import { mkdir } from 'node:fs/promises';
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
import { normalizeStill, normalizeVideo } from '../ffmpeg/normalize';
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
    const sources = await Promise.all(
      media.map((m) =>
        dlLimit(async (): Promise<ResolvedSource | null> => {
          if (ctx.signal.aborted) throw new PipelineError('E_CANCELLED', 'fetch', 'cancelled');
          try {
            if (m.kind === 'video' || m.kind === 'image') {
              const row = await downloadToCache(
                {
                  provider: m.provider,
                  providerId: m.providerId,
                  kind: m.kind,
                  remoteUrl: m.remoteUrl ?? '',
                  ...(m.width != null ? { width: Number(m.width) } : {}),
                  ...(m.height != null ? { height: Number(m.height) } : {}),
                  ...(m.duration != null ? { duration: Number(m.duration) } : {}),
                  ...(m.license != null ? { license: m.license } : {}),
                  ...(m.author != null ? { author: m.author } : {}),
                  ...(m.pageUrl != null ? { pageUrl: m.pageUrl } : {}),
                },
                ctx.signal,
              );
              downloads += 1;
              if (m.kind === 'video') {
                const probe = await probeVideo(row.local_path);
                // Best-window in-point (doc 23 §7). Only worth it when there's slack to
                // move within; any failure degrades to the geometric fallback (§8).
                const needsWindow = probe.durationSec > 0;
                const motionSamples = needsWindow
                  ? await analyzeMotion(row.local_path, ctx.signal).catch((err) => {
                      ctx.log.warn(
                        { err, beat: m.idx },
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
            // textcard / generated — already local
            const local = m.thumbPath ?? m.remoteUrl ?? '';
            return { kind: m.kind === 'generated' ? 'generated' : 'textcard', path: local };
          } catch (err) {
            if (err instanceof PipelineError && err.code === 'E_CANCELLED') throw err;
            warnings.push(
              `E_DOWNLOAD: beat ${m.idx} (${m.provider}:${m.providerId}) — falling back`,
            );
            ctx.log.warn({ err, beat: m.idx }, 'download failed');
            return null;
          }
        }),
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
      const beatMedia: BuildBeatInput['media'] =
        src.kind === 'video'
          ? {
              kind: 'video',
              path: src.path,
              ...(src.sourceDurationSec !== undefined
                ? { sourceDurationSec: src.sourceDurationSec }
                : {}),
              ...(src.motionSamples ? { motionSamples: src.motionSamples } : {}),
            }
          : { kind: src.kind, path: src.path };
      beatsInput.push({
        idx: m.idx,
        text: m.text,
        narrationDurationSec,
        ...(m.shotType ? { shotType: m.shotType } : {}),
        ...(m.emotion ? { emotion: m.emotion } : {}),
        media: beatMedia,
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
          const outPath = join(clipsDir, `${beat.idx}.mp4`);
          if (beat.media.kind === 'video') {
            await normalizeVideo({
              src: beat.media.path,
              inPointSec: beat.media.inPointSec ?? 0,
              headPadSec: entry.headPadSec,
              lengthSec: entry.lengthSec,
              sourceDurationSec: beat.media.sourceDurationSec ?? entry.lengthSec,
              width,
              height,
              outPath,
              signal: ctx.signal,
            });
          } else {
            await normalizeStill({
              src: beat.media.path,
              kenburns: beat.media.kenburns,
              lengthSec: entry.lengthSec,
              width,
              height,
              outPath,
              signal: ctx.signal,
            });
          }
          done += 1;
          report(
            20 + Math.round((70 * done) / timeline.beats.length),
            `normalized ${done}/${timeline.beats.length}`,
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
