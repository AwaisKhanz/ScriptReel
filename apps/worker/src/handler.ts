import {
  invariant,
  type JobMode,
  PipelineError,
  type PipelinePayload,
  type PipelineStage,
  parseSettings,
  STAGES,
} from '@scriptreel/core';
import * as db from '@scriptreel/db';
import type { Logger } from 'pino';
import { alignStage } from './pipeline/align';
import { analyzeStage } from './pipeline/analyze';
import { composeStage } from './pipeline/compose';
import type { ProjectCtx, Stage } from './pipeline/context';
import { FAKE_STAGES } from './pipeline/fake-stages';
import { fetchStage } from './pipeline/fetch';
import { runStages } from './pipeline/runner';
import { scoreStage } from './pipeline/score';
import { searchStage } from './pipeline/search';
import { ttsStage } from './pipeline/tts';

const REAL_STAGES = new Map<PipelineStage, Stage>([
  [analyzeStage.name, analyzeStage],
  [searchStage.name, searchStage],
  [scoreStage.name, scoreStage],
  [ttsStage.name, ttsStage],
  [alignStage.name, alignStage],
  [fetchStage.name, fetchStage],
  [composeStage.name, composeStage],
]);
const FAKE_BY_NAME = new Map<PipelineStage, Stage>(FAKE_STAGES.map((stage) => [stage.name, stage]));

function resolveStage(name: PipelineStage, fake: boolean): Stage {
  const stage = fake ? FAKE_BY_NAME.get(name) : (REAL_STAGES.get(name) ?? FAKE_BY_NAME.get(name));
  invariant(stage, `no stage registered for ${name}`, 'worker');
  return stage;
}

export interface RunPipelineOptions {
  fake: boolean;
  force?: boolean;
  log: Logger;
}

// The `pipeline` queue handler and its DAG (doc 06 §Stage graph):
//   analyze → [search→score ∥ tts] → REVIEW GATE → align → fetch → compose
// Modes: full (with gate), continue (post-gate), composeOnly (re-render), stage:<name>.
export async function runPipeline(
  payload: PipelinePayload,
  opts: RunPipelineOptions,
): Promise<void> {
  const { projectId, mode } = payload;
  const project = await db.getProject(projectId);
  invariant(project, `project ${projectId} not found`, 'worker');

  const settings = parseSettings(project.settings);
  await db.ensurePipelineRuns(projectId, STAGES);
  await db.clearCancel(projectId);
  await db.setProjectStatus(projectId, 'running');

  const controller = new AbortController();
  const ctx: ProjectCtx = {
    projectId,
    settings,
    fake: opts.fake,
    log: opts.log,
    signal: controller.signal,
  };
  const runOpts = { force: opts.force ?? false, controller };
  const run = (names: PipelineStage[]): Promise<void> =>
    runStages(
      ctx,
      names.map((n) => resolveStage(n, opts.fake)),
      runOpts,
    );

  // Poll the cancel flag DURING stages (not just between them) so a cancel mid-encode
  // aborts the FFmpeg child promptly via ctx.signal (doc 06 §Cancellation).
  const cancelPoll = setInterval(() => {
    void db
      .isCancelRequested(projectId)
      .then((requested) => {
        if (requested) controller.abort();
      })
      .catch(() => {});
  }, 1000);

  try {
    const singleStage = stageOfMode(mode);
    if (singleStage) {
      await run([singleStage]); // CLI single-stage; leaves project status as-is
    } else if (mode === 'composeOnly') {
      await run(['compose']);
      await db.setProjectStatus(projectId, 'done');
    } else if (mode === 'continue') {
      await run(['align', 'fetch', 'compose']); // pre-gate stages already complete
      await db.setProjectStatus(projectId, 'done');
    } else {
      // mode === 'full'
      await run(['analyze']);
      // tts is independent of search/score → run the two branches concurrently. A
      // failure in one aborts the controller so the other stops at its next check.
      const branch = (names: PipelineStage[]): Promise<void> =>
        run(names).catch((err) => {
          controller.abort();
          throw err;
        });
      await Promise.all([branch(['search', 'score']), branch(['tts'])]);

      if (settings.reviewBeforeRender) {
        await db.setProjectStatus(projectId, 'awaiting_review');
        opts.log.info({ projectId }, 'awaiting review — paused at storyboard');
        return; // complete the job; UI Continue enqueues mode:continue
      }
      await run(['align', 'fetch', 'compose']);
      await db.setProjectStatus(projectId, 'done');
    }
    opts.log.info({ projectId, mode }, 'pipeline finished');
  } catch (err) {
    if (err instanceof PipelineError && err.code === 'E_CANCELLED') {
      await db.resetRunningRuns(projectId); // revert the interrupted stage to pending
      await db.setProjectStatus(projectId, 'draft'); // cancel → clean draft, manifests intact
      opts.log.warn({ projectId }, 'cancelled — project reset to draft');
      return;
    }
    const pipelineError = err instanceof PipelineError ? err : null;
    await db.setProjectError(projectId, {
      stage: pipelineError?.stage ?? 'worker',
      code: pipelineError?.code ?? 'E_INVARIANT',
      message: err instanceof Error ? err.message : String(err),
    });
    opts.log.error({ err, retryable: pipelineError?.retryable ?? false }, 'pipeline failed');
    // Retryable (network/quota/ffmpeg/sidecar) → rethrow so pg-boss retries; others stay failed.
    if (pipelineError?.retryable) throw err;
  } finally {
    clearInterval(cancelPoll);
  }
}

function stageOfMode(mode: JobMode): PipelineStage | null {
  if (mode.startsWith('stage:')) {
    const name = mode.slice('stage:'.length);
    return (STAGES as readonly string[]).includes(name) ? (name as PipelineStage) : null;
  }
  return null;
}
