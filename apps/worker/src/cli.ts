import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { rootDir } from '@scriptreel/config';
import { type PipelineStage, STAGES } from '@scriptreel/core';
import * as db from '@scriptreel/db';
import pino from 'pino';
import { runPipeline } from './handler';

// Harness: `pnpm stage [name] --project <id> [--script-file <path>] [--title <t>]
//           [--fake] [--force] [--cancel-after <ms>]`
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

interface Args {
  stage?: PipelineStage;
  projectId?: string;
  scriptFile?: string;
  title?: string;
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
      if (value !== undefined) args.projectId = value;
    } else if (token === '--script-file') {
      i += 1;
      const value = argv[i];
      if (value !== undefined) args.scriptFile = value;
    } else if (token === '--title') {
      i += 1;
      const value = argv[i];
      if (value !== undefined) args.title = value;
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

async function resolveProjectId(args: Args): Promise<string | null> {
  if (args.scriptFile) {
    // Relative --script-file paths anchor to the repo root, not the worker's cwd.
    const path = isAbsolute(args.scriptFile) ? args.scriptFile : resolve(rootDir, args.scriptFile);
    const script = await readFile(path, 'utf8');
    const created = await db.createProject({
      id: args.projectId ?? randomUUID(),
      title: args.title ?? basename(args.scriptFile),
      script,
    });
    log.info(
      { projectId: created.id, scriptFile: args.scriptFile },
      'created project from script file',
    );
    return created.id;
  }
  if (args.projectId && (await db.getProject(args.projectId))) {
    return args.projectId;
  }
  if (args.fake) {
    const created = await db.createProject({
      id: args.projectId ?? randomUUID(),
      title: 'Fake pipeline project',
      script:
        'Placeholder script for the --fake stage-runner harness. It only needs to be long enough to satisfy the projects.script length check.',
    });
    log.info({ projectId: created.id }, 'created fake project');
    return created.id;
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectId = await resolveProjectId(args);
  if (!projectId) {
    log.error('No project. Pass --script-file <path> to create one, or --fake for a placeholder.');
    process.exitCode = 1;
    return;
  }

  if (args.cancelAfterMs !== undefined) {
    const ms = args.cancelAfterMs;
    setTimeout(() => {
      log.warn({ afterMs: ms }, 'requesting cancel mid-walk');
      void db.requestCancel(projectId).catch((err) => log.warn({ err }, 'cancel request failed'));
    }, ms);
  }

  await runPipeline(
    { projectId, mode: args.stage ? `stage:${args.stage}` : 'full' },
    {
      fake: args.fake,
      force: args.force,
      ...(args.stage ? { only: args.stage } : {}),
      log: log.child({ projectId }),
    },
  );

  const runs = await db.getPipelineRuns(projectId);
  const summary = STAGES.map(
    (stage) => `${stage}:${runs.find((r) => r.stage === stage)?.status ?? '—'}`,
  ).join('  ');
  log.info({ projectId }, `runs → ${summary}`);
}

main()
  .catch((err) => {
    log.error({ err }, 'stage cli failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void db.closeDb().finally(() => process.exit(process.exitCode ?? 0));
  });
