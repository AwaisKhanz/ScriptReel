import { join } from 'node:path';
import { paths } from '@scriptreel/config';
import {
  type AlignBeat,
  type AlignedWord,
  alignWords,
  hashObject,
  invariant,
  PipelineError,
  proportionalAlign,
  tokenMatchRate,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import { alignAudio } from '../sidecar/client';
import { writeWordsJson } from '../subtitles/render-ass';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

// align stage (doc 11): forced alignment of vo.wav → token map onto the known
// script → subs/words.json. Whisper failure degrades to proportional timing.
export const alignStage: Stage = {
  name: 'align',

  async inputsHash(ctx: ProjectCtx): Promise<string> {
    const beats = await db.getBeats(ctx.projectId);
    return hashObject({
      stage: 'align',
      narration: beats.map((b) => b.narration),
      language: ctx.settings.language ?? null,
    });
  },

  async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
    const project = await db.getProject(ctx.projectId);
    invariant(project, `project ${ctx.projectId} not found`, 'align');
    const beats = await db.getBeats(ctx.projectId);
    const language = project.language ?? ctx.settings.language ?? 'en-US';

    const alignBeats: AlignBeat[] = beats
      .map((beat) => {
        const narration = beat.narration as { startSec?: number; durationSec?: number } | null;
        return {
          idx: beat.idx,
          text: beat.text,
          startSec: narration?.startSec ?? 0,
          durationSec: narration?.durationSec ?? 0,
          language,
        };
      })
      .filter((beat) => beat.durationSec > 0);
    invariant(alignBeats.length > 0, 'no narration to align — run tts first', 'align');

    const voPath = join(paths.projectDir(ctx.projectId), 'audio', 'vo.wav');
    const scriptText = beats.map((beat) => beat.text).join(' ');

    let words: AlignedWord[];
    let mode: 'whisper' | 'proportional';
    let matchRate = 0;
    const warnings: string[] = [];
    try {
      report(20, 'aligning with whisper');
      const result = await alignAudio(
        { audioPath: voPath, language, text: scriptText },
        ctx.signal,
      );
      matchRate = tokenMatchRate(alignBeats, result.words);
      if (matchRate < 0.5) {
        // Whisper couldn't align this language/audio (e.g. Kokoro-hi ↔ whisper-hi).
        ctx.log.warn({ matchRate }, 'low whisper match — using proportional timing');
        warnings.push(
          `E_ALIGN: low whisper match (${matchRate.toFixed(2)}); used proportional timing`,
        );
        words = proportionalAlign(alignBeats);
        mode = 'proportional';
      } else {
        words = alignWords(alignBeats, result.words);
        mode = 'whisper';
      }
    } catch (err) {
      if (err instanceof PipelineError && err.code === 'E_CANCELLED') {
        throw err;
      }
      // Whisper/sidecar failure is a warning, not a failure (doc 07 invariant 7).
      ctx.log.warn({ err }, 'alignment failed — proportional fallback (E_ALIGN)');
      warnings.push('E_ALIGN: whisper alignment failed; used proportional timing');
      words = proportionalAlign(alignBeats);
      mode = 'proportional';
    }

    report(85, 'writing words.json');
    await writeWordsJson(ctx.projectId, words);
    return {
      artifacts: ['subs/words.json'],
      warnings,
      meta: {
        mode,
        wordCount: words.length,
        matchRate: Number(matchRate.toFixed(3)),
        language,
      },
    };
  },
};
