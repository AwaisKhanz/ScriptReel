import { randomUUID } from 'node:crypto';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { paths, rootDir } from '@scriptreel/config';
import {
  assertRenderInvariants,
  assertTimelineInvariants,
  type BuildBeatInput,
  buildTimeline,
  composePlan,
  hashObject,
  invariant,
  type SubtitleAspect,
  type SubtitlePreset,
  type Timeline,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { assembleVisual, encodeFinal, makeThumbnail } from '../ffmpeg/assemble';
import { probeAudio, probeVideo } from '../ffmpeg/probe';
import { writeRenderAss } from '../subtitles/render-ass';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

function dimsFor(aspect: string): [number, number] {
  if (aspect === '9:16') return [1080, 1920];
  if (aspect === '1:1') return [1080, 1080];
  return [1920, 1080];
}

function draftDims(width: number, height: number): [number, number] {
  const round2 = (x: number): number => Math.round(x / 2) * 2;
  return [round2((width * 2) / 3), round2((height * 2) / 3)];
}

// Auto music: dominant beat emotion → music mood (doc 02 §6).
const EMOTION_TO_MUSIC_MOOD: Record<string, string> = {
  uplifting: 'uplifting',
  inspiring: 'uplifting',
  calm: 'calm',
  neutral: 'calm',
  serious: 'corporate',
  tense: 'tense',
  sad: 'emotional',
  exciting: 'energetic',
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveMusic(
  ctx: ProjectCtx,
  beats: db.ChosenMediaRow[],
  warnings: string[],
): Promise<{ music: Timeline['music']; credit: string | null }> {
  const { musicMood, musicTrackId, musicLevelDb } = ctx.settings;
  if (musicMood === 'none') return { music: null, credit: null };

  let track: db.MusicTrackRow | null = null;
  if (musicTrackId) {
    track = await db.getMusicTrackById(musicTrackId);
  } else {
    const tracks = await db.getMusicTracks();
    let mood = musicMood as string;
    if (musicMood === 'auto') {
      const counts = new Map<string, number>();
      for (const b of beats) if (b.emotion) counts.set(b.emotion, (counts.get(b.emotion) ?? 0) + 1);
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral';
      mood = EMOTION_TO_MUSIC_MOOD[dominant] ?? 'calm';
    }
    track = tracks.find((t) => t.moods.includes(mood)) ?? tracks[0] ?? null;
  }

  if (!track) return { music: null, credit: null };
  const trackPath = isAbsolute(track.path) ? track.path : resolve(rootDir, track.path);
  if (!(await exists(trackPath))) {
    warnings.push(
      `E_MUSIC: track "${track.id}" file missing (${track.path}) — rendering without music`,
    );
    return { music: null, credit: null };
  }
  return {
    music: {
      path: trackPath,
      gainDb: musicLevelDb,
      fadeOutSec: 2,
      credit: track.credit ?? track.title,
    },
    credit: `Music: ${track.title} — ${track.credit ?? 'CC0'}`,
  };
}

// compose stage (doc 13 Pass B + C, doc 12): freeze the timeline, assemble the
// xfade chain, burn subtitles, mix VO + sidechain-ducked music, encode, verify.
export const composeStage: Stage = {
  name: 'compose',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const media = await db.getChosenMedia(ctx.projectId);
    return hashObject({
      stage: 'compose',
      chosen: media.map((m) => [m.idx, m.provider, m.providerId, m.kind]),
      settings: {
        aspect: ctx.settings.aspect,
        quality: ctx.settings.quality,
        transitionStyle: ctx.settings.transitionStyle,
        crossfadeSec: ctx.settings.crossfadeSec,
        subtitlePreset: ctx.settings.subtitlePreset,
        musicMood: ctx.settings.musicMood,
        musicTrackId: ctx.settings.musicTrackId ?? null,
        musicLevelDb: ctx.settings.musicLevelDb,
      },
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    const media = await db.getChosenMedia(ctx.projectId);
    invariant(media.length > 0, 'no chosen media — run score/fetch first', 'compose');
    const project = await db.getProject(ctx.projectId);
    invariant(project, `project ${ctx.projectId} not found`, 'compose');

    const { aspect, quality, transitionStyle, crossfadeSec, pauseMs, subtitlePreset } =
      ctx.settings;
    const preset = quality === 'draft' ? 'draft' : 'final';
    const [width, height] = dimsFor(aspect);
    const clipsDir = join(paths.projectDir(ctx.projectId), 'clips');
    const voPath = join(paths.projectDir(ctx.projectId), 'audio', 'vo.wav');
    const warnings: string[] = [];

    // 1) Subtitles: build render.ass from the align output, unless disabled/missing.
    report(5, 'preparing subtitles + music');
    let subtitles: Timeline['subtitles'] = null;
    if (subtitlePreset !== 'none') {
      const wordsPath = join(paths.projectDir(ctx.projectId), 'subs', 'words.json');
      if (await exists(wordsPath)) {
        const { readFile } = await import('node:fs/promises');
        const words = JSON.parse(await readFile(wordsPath, 'utf8'));
        const language = project.language ?? ctx.settings.language ?? 'en-US';
        const assPath = await writeRenderAss(
          ctx.projectId,
          words,
          subtitlePreset as SubtitlePreset,
          aspect as SubtitleAspect,
          language,
        );
        subtitles = { assPath, preset: subtitlePreset as Exclude<SubtitlePreset, 'none'> };
      } else {
        warnings.push('subtitles: no words.json (run align) — rendering without subtitles');
      }
    }

    // 2) Music: auto/pick/none; missing files degrade to no music.
    const { music, credit: musicCredit } = await resolveMusic(ctx, media, warnings);

    // 3) Build + validate the authoritative timeline (media = the normalized clips).
    const voProbe = await probeAudio(voPath);
    const beatsInput: BuildBeatInput[] = media.map((m) => {
      const narrationDurationSec =
        (m.narration as { durationSec?: number } | null)?.durationSec ?? 0;
      const clipPath = join(clipsDir, `${m.idx}.mp4`);
      const provenance = {
        ...(m.provider ? { provider: m.provider } : {}),
        ...(m.providerId ? { providerId: m.providerId } : {}),
        ...(m.author ? { author: m.author } : {}),
        ...(m.pageUrl ? { pageUrl: m.pageUrl } : {}),
      };
      const beatMedia: BuildBeatInput['media'] =
        m.kind === 'video'
          ? { kind: 'video', path: clipPath, ...provenance }
          : {
              kind:
                m.kind === 'generated' ? 'generated' : m.kind === 'image' ? 'image' : 'textcard',
              path: clipPath,
              ...provenance,
            };
      return {
        idx: m.idx,
        text: m.text,
        narrationDurationSec,
        ...(m.shotType ? { shotType: m.shotType } : {}),
        ...(m.emotion ? { emotion: m.emotion } : {}),
        media: beatMedia,
      };
    });

    const credits = buildCredits(media, musicCredit);
    const timeline: Timeline = buildTimeline({
      projectId: ctx.projectId,
      createdAt: new Date(project.created_at).toISOString(),
      render: { aspect: aspect as SubtitleAspect, width, height, preset },
      narration: { audioPath: voPath, durationSec: voProbe.durationSec },
      beats: beatsInput,
      pauseSec: pauseMs / 1000,
      transitions: { style: transitionStyle, crossfadeSec },
      music,
      subtitles,
      credits,
    });
    assertTimelineInvariants(timeline);
    await writeFile(
      join(paths.projectDir(ctx.projectId), 'timeline.json'),
      JSON.stringify(timeline, null, 2),
      'utf8',
    );

    // 4) Pass B — assemble the xfade/concat chain.
    report(25, 'assembling video');
    const rid = randomUUID();
    const renderDir = join(paths.projectDir(ctx.projectId), 'renders', rid);
    await mkdir(renderDir, { recursive: true });
    const clipPaths = timeline.beats.map((b) => join(clipsDir, `${b.idx}.mp4`));
    const videoNoSub = join(renderDir, 'video_nosub.mp4');
    await assembleVisual(clipPaths, composePlan(timeline), videoNoSub, ctx.signal);

    // 5) Pass C — subtitles + audio + encode.
    report(60, 'encoding final');
    const finalPath = join(renderDir, 'final.mp4');
    await encodeFinal({
      videoNoSub,
      voPath,
      music,
      assPath: subtitles?.assPath ?? null,
      fontsDir: resolve(rootDir, 'assets/fonts'),
      durationSec: timeline.narration.durationSec,
      width,
      height,
      aspect,
      preset,
      outPath: finalPath,
      signal: ctx.signal,
    });

    // 6) Post-render assertions (doc 13 §Post-render) — E_COMPOSE_VERIFY on any mismatch.
    report(90, 'verifying render');
    const [expW, expH] = preset === 'draft' ? draftDims(width, height) : [width, height];
    const vProbe = await probeVideo(finalPath);
    const aProbe = await probeAudio(finalPath);
    const bytes = (await stat(finalPath)).size;
    const driftMs = Math.abs(vProbe.durationSec - timeline.narration.durationSec) * 1000;
    assertRenderInvariants(
      {
        durationSec: vProbe.durationSec,
        width: vProbe.width,
        height: vProbe.height,
        fps: vProbe.fps,
        sampleRate: aProbe.sampleRate,
        bytes,
      },
      { durationSec: timeline.narration.durationSec, width: expW, height: expH },
    );

    // 7) Thumbnail + credits.txt + renders row (frozen timeline).
    const thumbPath = join(renderDir, 'thumbnail.jpg');
    await makeThumbnail(finalPath, timeline.narration.durationSec * 0.15, thumbPath, ctx.signal);
    await writeFile(join(renderDir, 'credits.txt'), credits, 'utf8');
    await db.insertRender({
      projectId: ctx.projectId,
      preset,
      aspect,
      path: finalPath,
      thumbnailPath: thumbPath,
      duration: vProbe.durationSec,
      bytes,
      timeline: timeline as unknown as db.RenderInsert['timeline'],
    });

    report(100, `rendered ${(bytes / 1_048_576).toFixed(1)}MB`);
    return {
      artifacts: [
        `renders/${rid}/final.mp4`,
        `renders/${rid}/thumbnail.jpg`,
        `renders/${rid}/credits.txt`,
        'timeline.json',
      ],
      warnings,
      meta: {
        renderId: rid,
        preset,
        aspect,
        durationSec: Number(vProbe.durationSec.toFixed(3)),
        driftMs: Number(driftMs.toFixed(1)),
        width: expW,
        height: expH,
        bytes,
        hasMusic: music !== null,
        hasSubtitles: subtitles !== null,
      },
    };
  },
};

// credits.txt (doc 08 §Credits, doc 13): one line per used asset + music + voice.
function buildCredits(media: db.ChosenMediaRow[], musicCredit: string | null): string {
  const providerName = (p: string): string =>
    p === 'pexels' ? 'Pexels' : p === 'pixabay' ? 'Pixabay' : p;
  const lines = media.map((m) => {
    const author = m.author ?? 'Unknown';
    const via = m.provider === 'textcard' ? 'ScriptReel' : `${providerName(m.provider)}`;
    const url = m.pageUrl ? ` — ${m.pageUrl}` : '';
    return `#${m.idx}: ${m.kind} by ${author} via ${via}${url}`;
  });
  if (musicCredit) lines.push(musicCredit);
  lines.push('Voice: Kokoro-82M (Apache-2.0)');
  return lines.join('\n');
}
