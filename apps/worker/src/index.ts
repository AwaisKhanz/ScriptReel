import { env, isLocalDatabase } from '@scriptreel/config';
import { type JobMode, PIPELINE_QUEUE, PipelinePayloadSchema } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import PgBoss from 'pg-boss';
import pino from 'pino';
import { runPipeline } from './handler';

const log = pino({
  level: 'info',
  // Defence-in-depth: never leak secrets if the env is ever logged (doc 18).
  redact: {
    paths: ['env.OPENAI_API_KEY', 'env.DATABASE_URL'],
    remove: true,
  },
});

async function main(): Promise<void> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    ssl: isLocalDatabase ? false : { rejectUnauthorized: false }, // local: no TLS; Supabase pooler: TLS
    max: 3, // session pooler budget (see packages/db/client.ts): worker gets 3+3
  });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();

  // pipeline: one video at a time (batchSize 1); parallelism lives inside stages
  // (doc 06). retry twice for retryable failures. `expireInSeconds` is how long a job
  // that a dead worker was holding stays stuck before pg-boss re-dispatches it — kept
  // safely above the longest render but low enough that a crashed run RESUMES within
  // ~30 min (stages are idempotent, so the retry skips completed work). Single worker +
  // batchSize 1 means an expired-but-still-running job can't be double-processed.
  // policy 'stately' makes singletonKey=projectId actually dedupe (see apps/web/lib/queue.ts and
  // 0013_pgboss_stately.sql) — 'standard', the default, builds no singleton index so duplicate
  // jobs pile up and the reconciler below re-enqueues on top of a live job. Both createQueue
  // callers must agree; whichever runs first wins the ON CONFLICT DO NOTHING, so they cannot differ.
  await boss.createQueue(PIPELINE_QUEUE, {
    name: PIPELINE_QUEUE,
    policy: 'stately',
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 1800,
  });
  await boss.work(PIPELINE_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = PipelinePayloadSchema.parse(job.data);
      await runPipeline(payload, {
        fake: false,
        log: log.child({ projectId: payload.projectId, jobId: job.id }),
      });
    }
  });

  log.info({ queues: [PIPELINE_QUEUE] }, 'worker up — pg-boss queues registered');

  // Self-heal orphaned jobs. A project can end up marked queued/running in the DB with NO live
  // pg-boss job — a send that was deduped on its singletonKey (a lingering prior job), a job that
  // failed off the retry ladder, or one lost when a worker died. Nothing else recovers it (the
  // generate route 409s an already-active project, so the user can't re-trigger it either), so it
  // sits "Queued" forever, even across restarts. Re-send each stuck project on startup and on an
  // interval: the singletonKey makes it a no-op when a live job already exists, and recreates the
  // job when the queue lost it; idempotent stages then skip the work already done.
  const reconcile = async (reason: string): Promise<void> => {
    try {
      // 60s was only ever safe because nothing heartbeat it — every running project looked stuck
      // after a minute. setStageProgress now beats projects.updated_at, so this measures real
      // silence. Keep it well clear of the gap between two progress reports: score reports per
      // beat, and one beat can sit behind a media-fit VLM timeout.
      const stuck = await db.getStuckProjects(10 * 60);
      if (stuck.length === 0) return;
      let requeued = 0;
      for (const p of stuck) {
        // Resume from where the project actually was, not from the top. If the brain + fetch are
        // already done, only the render (align/compose) remains → `continue`. Re-running `full`
        // would needlessly redo analyze/search/score AND, with review enabled, bounce the user back
        // to a storyboard they already approved (a paused full is `awaiting_review`, which we don't
        // touch — so a queued/running project past fetch is a post-approval continue).
        const runs = await db.getPipelineRuns(p.id);
        const isDone = (stage: string): boolean => {
          const status = runs.find((r) => r.stage === stage)?.status;
          return status === 'done' || status === 'skipped';
        };
        const mode: JobMode =
          ['analyze', 'search', 'score', 'tts', 'fetch'].every(isDone) &&
          (!isDone('align') || !isDone('compose'))
            ? 'continue'
            : 'full';
        // Clear any stage a dead worker left frozen at 'running' (e.g. a `pnpm dev` restart mid-run):
        // getStuckProjects only returns projects silent >10 min, so a 'running' row here is abandoned,
        // not live. Resetting it to 'pending' stops the UI showing a frozen "running 10%" until the
        // requeued job supersedes it; idempotent stages still skip whatever genuinely completed.
        await db.resetRunningRuns(p.id);
        const id = await boss.send(
          PIPELINE_QUEUE,
          { projectId: p.id, mode },
          { singletonKey: p.id },
        );
        if (id) requeued += 1;
      }
      log.info({ reason, stuck: stuck.length, requeued }, 'reconciled stuck pipeline jobs');
    } catch (err) {
      log.error({ err }, 'reconcile failed');
    }
  };
  await reconcile('startup');
  const reconcileTimer = setInterval(() => void reconcile('periodic'), 5 * 60 * 1000);
  reconcileTimer.unref(); // don't keep the process alive for the timer alone

  const shutdown = (signal: NodeJS.Signals): void => {
    clearInterval(reconcileTimer);
    log.info({ signal }, 'worker shutting down');
    void boss
      .stop({ graceful: true })
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error({ err }, 'worker failed to boot');
  process.exit(1);
});
