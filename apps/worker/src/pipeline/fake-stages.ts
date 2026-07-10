import { hashObject, PipelineError, type PipelineStage, STAGES } from '@scriptreel/core';
import type { ProjectCtx, Reporter, Stage, StageOutcome } from './context';

// Phase 1 placeholders: each stage just reports progress and honours cancellation.
// Phases 2–9 replace these one at a time with the real implementations.

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PipelineError('E_CANCELLED', 'worker', 'cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new PipelineError('E_CANCELLED', 'worker', 'cancelled'));
      },
      { once: true },
    );
  });
}

function fakeStage(name: PipelineStage): Stage {
  return {
    name,
    inputsHash(ctx: ProjectCtx): Promise<string> {
      return Promise.resolve(
        hashObject({ stage: name, projectId: ctx.projectId, settings: ctx.settings, fake: true }),
      );
    },
    async run(ctx: ProjectCtx, report: Reporter): Promise<StageOutcome> {
      for (const pct of [25, 50, 75, 100]) {
        if (ctx.signal.aborted) {
          throw new PipelineError('E_CANCELLED', name, 'cancelled');
        }
        report(pct, `fake ${name} ${pct}%`);
        await sleep(60, ctx.signal);
      }
      return {};
    },
  };
}

export const FAKE_STAGES: readonly Stage[] = STAGES.map(fakeStage);
