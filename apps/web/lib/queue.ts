import { env } from '@scriptreel/config';
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
      ssl: { rejectUnauthorized: false },
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
  await boss.createQueue(name, { name, retryLimit: 2, retryDelay: 30, expireInSeconds: 7200 });
  ensured.add(name);
}

// singletonKey = projectId → a project can never have two pipeline jobs at once.
export async function enqueuePipeline(projectId: string, mode: JobMode): Promise<string | null> {
  const boss = await getBoss();
  await ensureQueue(boss, PIPELINE_QUEUE);
  return boss.send(PIPELINE_QUEUE, { projectId, mode }, { singletonKey: projectId });
}
