import { env, isLocalDatabase } from '@scriptreel/config';
import { type JobMode, PIPELINE_QUEUE } from '@scriptreel/core';
import PgBoss from 'pg-boss';

// A single send-only pg-boss client for the API routes (the worker owns the
// handlers). Lazily started per server instance; queues are ensured once.
let bossPromise: Promise<PgBoss> | null = null;
const ensured = new Set<string>();

async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      ssl: isLocalDatabase ? false : { rejectUnauthorized: false }, // local: no TLS; Supabase: TLS
      max: 2, // send-only; session pooler budget (see packages/db/client.ts)
    });
    boss.on('error', () => {});
    // Clear the cache if the start fails, or a single transient DB blip at cold start poisons
    // this module for the life of the process: the rejected promise stays cached, and every
    // later generate/continue/rerender returns 502 "enqueue failed" until Next is restarted.
    // The retry costs one connection attempt; not retrying costs the whole app.
    bossPromise = boss.start().then(
      () => boss,
      (err: unknown) => {
        bossPromise = null;
        throw err;
      },
    );
  }
  return bossPromise;
}

async function ensureQueue(boss: PgBoss, name: string): Promise<void> {
  if (ensured.has(name)) return;
  // policy 'stately' is what makes singletonKey actually dedupe. Without it pg-boss defaults to
  // 'standard', which builds NONE of the singleton unique indexes — so `send(..., {singletonKey})`
  // never conflicts and every call inserts another job. Measured: one project accumulated 3 live
  // pipeline jobs (1 active + 2 created), a cancel aborted one and a duplicate restarted on the
  // next reconciler tick, and the worker's reconciler (which assumes the same key makes a re-send
  // a no-op) piled on more. 'stately' enforces one job per (project, state ≤ active), so a re-send
  // while one is queued/running is a no-op. NOTE: create_queue is ON CONFLICT DO NOTHING, so this
  // only takes on a queue that does not yet exist — an already-created 'standard' queue must be
  // migrated with `UPDATE pgboss.queue SET policy='stately'` (0013_pgboss_stately.sql).
  await boss.createQueue(name, {
    name,
    policy: 'stately',
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 7200,
  });
  ensured.add(name);
}

// singletonKey = projectId → with policy 'stately' a project can never have two pipeline jobs
// queued-or-running at once (see ensureQueue).
export async function enqueuePipeline(projectId: string, mode: JobMode): Promise<string | null> {
  const boss = await getBoss();
  await ensureQueue(boss, PIPELINE_QUEUE);
  return boss.send(PIPELINE_QUEUE, { projectId, mode }, { singletonKey: projectId });
}
