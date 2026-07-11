import { env } from '@scriptreel/config';
import {
  BEAT_RESEARCH_QUEUE,
  BeatResearchPayloadSchema,
  PIPELINE_QUEUE,
  PipelinePayloadSchema,
} from '@scriptreel/core';
import PgBoss from 'pg-boss';
import pino from 'pino';
import { runPipeline } from './handler';
import { runBeatResearch } from './pipeline/beat-research';

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
    max: 4, // session pooler budget (see packages/db/client.ts): worker gets 4+4
  });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();

  // pipeline: one video at a time (batchSize 1); parallelism lives inside stages
  // (doc 06). retry twice for retryable failures; expire abandoned jobs after 2 h.
  await boss.createQueue(PIPELINE_QUEUE, {
    name: PIPELINE_QUEUE,
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 7200,
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

  // beat-research: lightweight single-beat re-search from the storyboard (teamSize 2).
  await boss.createQueue(BEAT_RESEARCH_QUEUE, {
    name: BEAT_RESEARCH_QUEUE,
    retryLimit: 1,
    expireInSeconds: 600,
  });
  await boss.work(BEAT_RESEARCH_QUEUE, { batchSize: 2 }, async (jobs) => {
    for (const job of jobs) {
      const payload = BeatResearchPayloadSchema.parse(job.data);
      await runBeatResearch(payload, log.child({ beatId: payload.beatId }));
    }
  });

  log.info(
    { queues: [PIPELINE_QUEUE, BEAT_RESEARCH_QUEUE] },
    'worker up — pg-boss queues registered',
  );

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
