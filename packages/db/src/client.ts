import { env } from '@scriptreel/config';
import postgres from 'postgres';

// Single postgres.js pool over the Supabase session pooler (doc 05). The session
// pooler (:5432) supports prepared statements + LISTEN/NOTIFY, unlike the :6543
// transaction pooler. Connects lazily on first query.
//
// Connection budget: the session pooler caps total clients at 15. Both the web
// server and the worker import this pool AND each run a pg-boss pool, so the four
// pools must sum to < 15 or the pooler throws EMAXCONNSESSION and the worker dies
// mid-run. Budget with one web + one worker: web 3 (pg) + 2 (boss), worker 3 (pg)
// + 3 (boss) = 11, leaving ~4 slots of headroom. Never run two workers against the
// same pooler (2×6 + 5 = 17 > 15). Idle connections release after idle_timeout.
export const sql = postgres(env.DATABASE_URL, {
  max: 3,
  idle_timeout: 20,
  ssl: 'require',
});

export type Sql = typeof sql;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
