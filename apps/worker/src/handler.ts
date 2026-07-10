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
import type { ProjectCtx } from './pipeline/context';
import { FAKE_STAGES } from './pipeline/fake-stages';
import { runStages } from './pipeline/runner';

export interface RunPipelineOptions {
  fake: boolean;
  force?: boolean;
  only?: PipelineStage; // run a single stage (CLI); undefined = full walk
  log: Logger;
}

// The `pipeline` queue handler (doc 06). Phase 1 walks the fake stages only; the
// review gate, concurrency and real stages arrive in later phases.
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

  const stages = opts.only ? FAKE_STAGES.filter((stage) => stage.name === opts.only) : FAKE_STAGES;

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
