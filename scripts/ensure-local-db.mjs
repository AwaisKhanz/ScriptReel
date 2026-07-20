// predev hook: start the portable local Postgres before `pnpm dev`, if LOCAL_PG_DIR is set in .env.
// No-op (exit 0) when unset — Cloud/other setups are unaffected, and this NEVER blocks `pnpm dev`
// (any failure is swallowed). The machine-specific path lives in .env, never in a committed file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  let dir = process.env.LOCAL_PG_DIR;
  if (!dir && existsSync('.env')) {
    const m = readFileSync('.env', 'utf8').match(/^\s*LOCAL_PG_DIR\s*=\s*(.*)$/m);
    if (m)
      dir = m[1]
        .replace(/\s*#.*$/, '')
        .trim()
        .replace(/^["']|["']$/g, '');
  }
  if (!dir) process.exit(0); // not using local Postgres

  const pgctl = join(dir, 'pgsql', 'bin', 'pg_ctl.exe');
  const data = join(dir, 'data');
  if (!existsSync(pgctl)) {
    console.warn(`[db] LOCAL_PG_DIR set but pg_ctl not found at ${pgctl} — skipping`);
    process.exit(0);
  }
  try {
    execFileSync(pgctl, ['-D', data, 'status'], { stdio: 'ignore' });
    console.log('[db] local Postgres already running');
  } catch {
    console.log('[db] starting local Postgres…');
    execFileSync(pgctl, ['-D', data, '-l', join(dir, 'pg.log'), 'start'], { stdio: 'inherit' });
  }
} catch (err) {
  // Never block dev on this — the app will report a clear connection error if the DB is truly down.
  console.warn('[db] ensure-local-db skipped:', err?.message ?? err);
}
process.exit(0);
