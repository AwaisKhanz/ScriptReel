import { env } from '@scriptreel/config';
import { PIPELINE_QUEUE, PipelinePayloadSchema } from '@scriptreel/core';
import PgBoss from 'pg-boss';
import pino from 'pino';
import { runPipeline } from './handler';

const log = pino({
  level: 'info',
  // Defence-in-depth: never leak secrets if the env is ever logged (doc 18).
  redact: {
    paths: ['env.OPENAI_API_KEY', 'env.PEXELS_API_KEY', 'env.PIXABAY_API_KEY', 'env.DATABASE_URL'],
    remove: true,
  },
});

async function main(): Promise<void> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase pooler requires TLS
  });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));

  await boss.start();
  await boss.createQueue(PIPELINE_QUEUE);
  await boss.work(PIPELINE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const payload = PipelinePayloadSchema.parse(job.data);
      await runPipeline(payload, { fake: true, log: log.child({ projectId: payload.projectId }) });
    }
  });

  log.info({ queue: PIPELINE_QUEUE }, 'worker up — pg-boss pipeline queue registered');

  const shutdown = (signal: NodeJS.Signals): void => {
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
