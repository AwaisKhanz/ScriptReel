import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import { hashObject, invariant, langCodeForVoice, PipelineError } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pLimit from 'p-limit';
import { buildNarration } from '../ffmpeg/audio';
import { probeAudio } from '../ffmpeg/probe';
import { ttsSynthesize } from '../sidecar/client';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

const TTS_PARALLELISM = 2;

async function synthesizeBeat(
  params: { text: string; voice: string; langCode: string; speed: number; outPath: string },
  ctx: ProjectCtx,
  beatIdx: number,
): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (ctx.signal.aborted) {
      throw new PipelineError('E_CANCELLED', 'tts', 'cancelled');
    }
    try {
      const res = await ttsSynthesize(params, ctx.signal);
      return res.durationSec;
    } catch (err) {
      if (err instanceof PipelineError && err.code === 'E_SIDECAR_DOWN') {
        throw err;
      }
      lastErr = err;
      ctx.log.warn({ beatIdx, attempt, err }, 'tts beat failed; retrying');
    }
  }
  throw new PipelineError(
    'E_TTS_FAIL_BEAT',
    'tts',
    `beat ${beatIdx} narration failed — try another voice`,
    {
      cause: lastErr,
      beatIdx,
    },
  );
}

// tts stage (doc 10): per-beat Kokoro synthesis → master clock → concat + loudnorm
// to vo.wav (48 kHz, −16 LUFS). Measured durations drive every downstream duration.
export const ttsStage: Stage = {
  name: 'tts',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const beats = await db.getBeats(ctx.projectId);
    return hashObject({
      stage: 'tts',
      texts: beats.map((b) => b.text),
      voice: ctx.settings.voice,
      speed: ctx.settings.speed,
      pauseMs: ctx.settings.pauseMs,
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    const beats = await db.getBeats(ctx.projectId);
    invariant(beats.length > 0, 'no beats to narrate — run analyze first', 'tts');

    const { voice, speed } = ctx.settings;
    const langCode = langCodeForVoice(voice) ?? 'a';
    const pauseSec = ctx.settings.pauseMs / 1000;

    const audioDir = join(paths.projectDir(ctx.projectId), 'audio');
    const beatsDir = join(audioDir, 'beats');
    await mkdir(beatsDir, { recursive: true });

    const durations = new Array<number>(beats.length).fill(0);
    const limit = pLimit(TTS_PARALLELISM);
    let done = 0;
    await Promise.all(
      beats.map((beat, i) =>
        limit(async () => {
          const outPath = join(beatsDir, `${beat.idx}.wav`);
          durations[i] = await synthesizeBeat(
            { text: beat.text, voice, langCode, speed, outPath },
            ctx,
            beat.idx,
          );
          done += 1;
          report(
            Math.round((done / beats.length) * 70),
            JSON.stringify({ op: 'tts', beat: done, of: beats.length }),
          );
        }),
      ),
    );

    // Master clock: start[i] = start[i-1] + dur[i-1] + pause (narration is the clock).
    let start = 0;
    const beatPaths: string[] = [];
    for (let i = 0; i < beats.length; i += 1) {
      const beat = beats[i];
      const dur = durations[i];
      if (!beat || dur === undefined) continue;
      const audioPath = join(beatsDir, `${beat.idx}.wav`);
      await db.setBeatNarration(beat.id, { audioPath, durationSec: dur, startSec: start });
      beatPaths.push(audioPath);
      start += dur + pauseSec;
    }

    report(80, 'concatenating + loudnorm');
    const { voPath } = await buildNarration(beatPaths, pauseSec, audioDir, ctx.signal);

    const probe = await probeAudio(voPath);
    const expected =
      durations.reduce((acc, d) => acc + d, 0) + Math.max(0, beats.length - 1) * pauseSec;
    const driftMs = Math.abs(probe.durationSec - expected) * 1000;
    invariant(
      driftMs <= 50,
      `vo.wav drift ${driftMs.toFixed(1)}ms (measured ${probe.durationSec}s vs expected ${expected.toFixed(3)}s)`,
      'tts',
    );
    invariant(
      probe.sampleRate === 48_000,
      `vo.wav sample rate ${probe.sampleRate} != 48000`,
      'tts',
    );

    report(100, `vo.wav ${probe.durationSec.toFixed(2)}s`);
    return {
      artifacts: ['audio/vo.wav'],
      meta: {
        voice,
        langCode,
        durationSec: probe.durationSec,
        sampleRate: probe.sampleRate,
        beatCount: beats.length,
        driftMs: Number(driftMs.toFixed(1)),
      },
    };
  },
};
