import { randomUUID } from 'node:crypto';
import { type PipelineStage, STAGES } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pino from 'pino';
import { runPipeline } from './handler';

// Harness: `pnpm stage [name] --project <id> [--fake] [--force] [--cancel-after <ms>]`
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

interface Args {
  stage?: PipelineStage;
  projectId?: string;
  fake: boolean;
  force: boolean;
  cancelAfterMs?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fake: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--fake') {
      args.fake = true;
    } else if (token === '--force') {
      args.force = true;
    } else if (token === '--project') {
      i += 1;
      const value = argv[i];
      if (value !== undefined) {
        args.projectId = value;
      }
    } else if (token === '--cancel-after') {
      i += 1;
      args.cancelAfterMs = Number(argv[i]);
    } else if (token !== undefined && !token.startsWith('--')) {
      if ((STAGES as readonly string[]).includes(token)) {
        args.stage = token as PipelineStage;
      } else {
        throw new Error(`unknown stage '${token}' (expected one of: ${STAGES.join(', ')})`);
      }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fake) {
    log.error('Phase 1 has no real stages yet — run with --fake.');
    process.exitCode = 1;
    return;
  }

  let projectId = args.projectId;
  if (projectId === undefined || (await db.getProject(projectId)) === null) {
    const created = await db.createProject({
      id: projectId ?? randomUUID(),
      title: 'Fake pipeline project',
      script:
        'Placeholder script for the --fake stage-runner harness. It only needs to be long enough to satisfy the projects.script length check.',
    });
    projectId = created.id;
    log.info({ projectId }, 'created fake project');
  }

  const targetProjectId = projectId;
  if (args.cancelAfterMs !== undefined) {
    const ms = args.cancelAfterMs;
    setTimeout(() => {
      log.warn({ afterMs: ms }, 'requesting cancel mid-walk');
      void db
        .requestCancel(targetProjectId)
        .catch((err) => log.warn({ err }, 'cancel request failed'));
    }, ms);
  }

  await runPipeline(
    { projectId: targetProjectId, mode: args.stage ? `stage:${args.stage}` : 'full' },
    {
      fake: true,
      force: args.force,
      ...(args.stage ? { only: args.stage } : {}),
      log: log.child({ projectId: targetProjectId }),
    },
  );

  const runs = await db.getPipelineRuns(targetProjectId);
  const summary = STAGES.map((stage) => {
    const row = runs.find((r) => r.stage === stage);
    return `${stage}:${row?.status ?? '—'}`;
  }).join('  ');
  log.info({ projectId: targetProjectId }, `runs → ${summary}`);
}

main()
  .catch((err) => {
    log.error({ err }, 'stage cli failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void db.closeDb().finally(() => process.exit(process.exitCode ?? 0));
  });
