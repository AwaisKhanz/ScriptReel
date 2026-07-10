import { mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { env } from './env';

const dataDir = isAbsolute(env.DATA_DIR) ? env.DATA_DIR : resolve(process.cwd(), env.DATA_DIR);

// DATA_DIR layout per doc 03. Kept here (config, I/O allowed) — never in core.
export const paths = {
  dataDir,
  projectsDir: resolve(dataDir, 'projects'),
  cacheDir: resolve(dataDir, 'cache'),
  modelsDir: resolve(dataDir, 'models'),
  projectDir: (projectId: string): string => resolve(dataDir, 'projects', projectId),
} as const;

export function ensureDataDirs(): void {
  for (const dir of [paths.dataDir, paths.projectsDir, paths.cacheDir, paths.modelsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
