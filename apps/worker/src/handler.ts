import {
  invariant,
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
import type { ProjectCtx, Stage } from './pipeline/context';
import { FAKE_STAGES } from './pipeline/fake-stages';
import { fetchStage } from './pipeline/fetch';
import { runStages } from './pipeline/runner';
import { scoreStage } from './pipeline/score';
import { searchStage } from './pipeline/search';
import { ttsStage } from './pipeline/tts';

// Real stages replace fakes as phases land. `fake` forces all fakes (no OpenAI/etc.).
const REAL_STAGES = new Map<PipelineStage, Stage>([
  [analyzeStage.name, analyzeStage],
  [searchStage.name, searchStage],
  [scoreStage.name, scoreStage],
  [ttsStage.name, ttsStage],
  [alignStage.name, alignStage],
  [fetchStage.name, fetchStage],
]);
const FAKE_BY_NAME = new Map<PipelineStage, Stage>(FAKE_STAGES.map((stage) => [stage.name, stage]));

function resolveStages(fake: boolean): Stage[] {
  return STAGES.map((name) => {
    const stage = fake ? FAKE_BY_NAME.get(name) : (REAL_STAGES.get(name) ?? FAKE_BY_NAME.get(name));
    invariant(stage, `no stage registered for ${name}`, 'worker');
    return stage;
  });
}

export interface RunPipelineOptions {
  fake: boolean;
  force?: boolean;
  only?: PipelineStage; // run a single stage (CLI); undefined = full walk
  log: Logger;
}

// The `pipeline` queue handler (doc 06). No review gate / concurrency yet (Phase 10).
export async function runPipeline(
  payload: PipelinePayload,
  opts: RunPipelineOptions,
): Promise<void> {
  const { projectId } = payload;
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

  const all = resolveStages(opts.fake);
  const stages = opts.only ? all.filter((stage) => stage.name === opts.only) : all;

  try {
    await runStages(ctx, stages, { force: opts.force ?? false, controller });
    if (!opts.only) {
      await db.setProjectStatus(projectId, 'done');
    }
    opts.log.info({ projectId }, 'pipeline finished');
  } catch (err) {
    if (err instanceof PipelineError && err.code === 'E_CANCELLED') {
      await db.setProjectStatus(projectId, 'draft'); // cancel → clean draft, manifests intact
      opts.log.warn({ projectId }, 'pipeline cancelled — project reset to draft');
      return;
    }
    const pipelineError = err instanceof PipelineError ? err : null;
    await db.setProjectError(projectId, {
      stage: pipelineError?.stage ?? 'worker',
      code: pipelineError?.code ?? 'E_INVARIANT',
      message: err instanceof Error ? err.message : String(err),
    });
    opts.log.error({ err }, 'pipeline failed');
    throw err;
  }
}
