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
//   analyze → [search→score ∥ tts] → fetch → REVIEW GATE → align → compose
// fetch runs BEFORE the gate (doc 24 §8) so the storyboard previews each beat's real
// stitched montage clip. Modes: full (with gate), continue (post-gate), composeOnly, stage:<name>.
export async function runPipeline(
  payload: PipelinePayload,
  opts: RunPipelineOptions,
): Promise<void> {
  const { projectId, mode } = payload;
  const project = await db.getProject(projectId);
  invariant(project, `project ${projectId} not found`, 'worker');

  const settings = parseSettings(project.settings);
  await db.ensurePipelineRuns(projectId, STAGES);

  // `stage:<name>` is the CLI harness (pnpm stage score --project …) and must NOT touch the
  // project's status — it is a developer running one stage, not a render. Setting `running`
  // here unconditionally stranded the project at `running` forever once the stage returned
  // (nothing restores it): every run row reads `done`, progress reads 100, and the UI — which
  // routes on status, not on stage completion — shows "Generating 100%" with a Cancel button
  // and never reaches the player. Worse, index.ts's reconciler re-enqueues anything left
  // `queued`/`running` for >10 min, so a one-stage CLI invocation would silently trigger a
  // full unattended re-render against the free-tier budget.
  //
  // cancel_requested is cleared by the dispatch routes (generate/continue/rerender), NOT
  // here: clearing on every run would wipe a user's cancel when pg-boss retries a job whose
  // worker died mid-run — silently resuming a project the user asked to stop.
  const singleStage = stageOfMode(mode);
  if (!singleStage) await db.setProjectStatus(projectId, 'running');

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
    if (singleStage) {
      await run([singleStage]); // CLI single-stage; leaves project status as-is (see above)
    } else if (mode === 'composeOnly') {
      await run(['compose']);
      await db.setProjectStatus(projectId, 'done');
    } else if (mode === 'continue') {
      // fetch already ran pre-gate; re-run (idempotent) to re-stitch any beat changed at
      // review, then finish with align + compose.
      await run(['fetch', 'align', 'compose']);
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

      // Stitch each beat's montage BEFORE the gate (doc 24 §8) so the storyboard shows the
      // real combined per-beat clip. Heavier to reach review, but it's the accurate preview.
      await run(['fetch']);

      if (settings.reviewBeforeRender) {
        await db.setProjectStatus(projectId, 'awaiting_review');
        opts.log.info({ projectId }, 'awaiting review — paused at storyboard');
        return; // complete the job; UI Continue enqueues mode:continue
      }
      await run(['align', 'compose']);
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
    // Transient DB/pooler blips (EMAXCONNSESSION, DNS ENOTFOUND, dropped socket)
    // aren't real failures — let pg-boss retry (retryLimit 2, retryDelay 30) so the
    // job self-heals once connections free up instead of dying with E_INVARIANT.
    const transient = !pipelineError && isTransientDbError(err);
    const retryable = pipelineError?.retryable ?? transient;
    await db.setProjectError(projectId, {
      stage: pipelineError?.stage ?? 'worker',
      code: pipelineError?.code ?? (transient ? 'E_DB_TRANSIENT' : 'E_INVARIANT'),
      message: err instanceof Error ? err.message : String(err),
    });
    opts.log.error({ err, retryable }, 'pipeline failed');
    // Retryable (network/quota/ffmpeg/sidecar/db-transient) → rethrow so pg-boss retries.
    if (retryable) throw err;
  } finally {
    clearInterval(cancelPoll);
  }
}

// Transient connection failures against the Supabase pooler (or a flaky network)
// that should be retried rather than treated as a permanent invariant violation.
function isTransientDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  return (
    /EMAXCONNSESSION|max clients reached|too many clients|Connection terminated|connection timeout|read ECONNRESET/i.test(
      msg,
    ) ||
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE/i.test(msg) ||
    [
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ECONNRESET',
      'EPIPE',
      '53300',
      '57P01',
      'XX000',
    ].includes(code)
  );
}

function stageOfMode(mode: JobMode): PipelineStage | null {
  if (mode.startsWith('stage:')) {
    const name = mode.slice('stage:'.length);
    return (STAGES as readonly string[]).includes(name) ? (name as PipelineStage) : null;
  }
  return null;
}
