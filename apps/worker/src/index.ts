import { env } from '@scriptreel/config';
import pino from 'pino';

const log = pino({
  level: 'info',
  // Defence-in-depth: if a future log line ever includes the env, drop secrets (doc 18).
  redact: {
    paths: ['env.PEXELS_API_KEY', 'env.PIXABAY_API_KEY', 'env.GEMINI_API_KEY', 'env.DATABASE_URL'],
    remove: true,
  },
});

function main(): void {
  log.info(
    { llmProvider: env.LLM_PROVIDER, sidecarUrl: env.SIDECAR_URL },
    'worker up — Phase 0 scaffold (no queues registered yet)',
  );

  // Phase 1 registers the pg-boss `pipeline` queue here. Until then, hold the
  // event loop open so `pnpm dev` keeps the worker alive; shut down on signal.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = (signal: NodeJS.Signals): void => {
    clearInterval(keepAlive);
    log.info({ signal }, 'worker shutting down cleanly');
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  main();
} catch (error) {
  log.error({ error }, 'worker failed to boot');
  process.exit(1);
}
