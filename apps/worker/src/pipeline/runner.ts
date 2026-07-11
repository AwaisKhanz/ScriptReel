import { PipelineError, type PipelineStage } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import type { ProjectCtx, Reporter, Stage } from './context';
import { readManifest, writeManifest } from './manifest';

// Throttled progress reporter (doc 06 §3): DB writes at most every 500 ms; flush
// forces the final value. Writes are chained on one queue so they land in the order
// they were reported (a slow earlier UPDATE can't overwrite a newer one), and the SQL
// is monotonic besides (markRunProgress uses greatest()).
function createReporter(projectId: string, stage: PipelineStage, ctx: ProjectCtx): Reporter {
  let lastWrite = 0;
  let latestPct = 0;
  let latestDetail: string | undefined;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (pct: number, detail?: string): Promise<void> => {
    queue = queue
      .then(() => db.markRunProgress(projectId, stage, pct, detail))
      .catch((err) => ctx.log.warn({ err }, 'progress write failed'));
    return queue;
  };

  const report = ((pct: number, detail?: string): void => {
    latestPct = Math.max(latestPct, pct); // concurrent tasks may report out of order
    latestDetail = detail;
    ctx.log.debug({ stage, pct, detail }, 'progress');
    const now = Date.now();
    if (now - lastWrite >= 500) {
      lastWrite = now;
      void enqueue(latestPct, detail);
    }
  }) as Reporter;

  report.flush = async (pct?: number): Promise<void> => {
    await enqueue(pct ?? latestPct, latestDetail);
  };
  return report;
}

function toPipelineError(err: unknown, stage: PipelineStage): PipelineError {
  if (err instanceof PipelineError) {
    return err;
  }
  return new PipelineError('E_INVARIANT', stage, err instanceof Error ? err.message : String(err), {
    cause: err,
  });
}

export interface RunStagesOptions {
  force: boolean;
  controller: AbortController;
}

// The resume engine (doc 06): skip on inputsHash match, else run → manifest → done.
export async function runStages(
  ctx: ProjectCtx,
  stages: readonly Stage[],
  opts: RunStagesOptions,
): Promise<void> {
  for (const stage of stages) {
    // Stop on a user cancel (DB flag) or a sibling-branch failure (controller abort).
    const cancelRequested = ctx.signal.aborted || (await db.isCancelRequested(ctx.projectId));
    ctx.log.debug({ stage: stage.name, cancelRequested }, 'cancel check');
    if (cancelRequested) {
      opts.controller.abort();
      throw new PipelineError('E_CANCELLED', stage.name, 'cancelled');
    }

    const inputsHash = await stage.inputsHash(ctx);
    const manifest = await readManifest(ctx.projectId, stage.name);
    if (!opts.force && manifest && manifest.inputsHash === inputsHash) {
      await db.markRunSkipped(ctx.projectId, stage.name);
      ctx.log.info({ stage: stage.name }, 'skipped (inputsHash match)');
      continue;
    }

    await db.markRunRunning(ctx.projectId, stage.name);
    const report = createReporter(ctx.projectId, stage.name, ctx);
    try {
      const outcome = await stage.run(ctx, report);
      await report.flush(100);
      await writeManifest(ctx.projectId, stage.name, {
        stage: stage.name,
        inputsHash,
        completedAt: new Date().toISOString(),
        artifacts: outcome.artifacts ?? [],
        warnings: outcome.warnings ?? [],
        ...(outcome.meta ? { meta: outcome.meta } : {}),
      });
      await db.markRunDone(ctx.projectId, stage.name);
      ctx.log.info({ stage: stage.name }, 'done');
    } catch (err) {
      const pipelineError = toPipelineError(err, stage.name);
      // A cancel isn't a stage failure — leave the run resumable (no manifest was
      // written), the project is reset to draft by the handler.
      if (pipelineError.code !== 'E_CANCELLED') {
        await db.markRunFailed(ctx.projectId, stage.name, {
          stage: stage.name,
          code: pipelineError.code,
          message: pipelineError.message,
        });
      }
      throw pipelineError;
    }
  }
}
