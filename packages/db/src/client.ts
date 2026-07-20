import { env, isLocalDatabase } from '@scriptreel/config';
import postgres from 'postgres';

// Single postgres.js pool (doc 05). One config serves two backends, auto-detected from the URL:
//
//   - LOCAL Postgres (127.0.0.1:54322): no SSL, ~100 max_connections. Generous pool, no ceiling
//     to budget against — this is the default the project ships with (.env.example) and the fix for
//     the Supabase pooler's EMAXCONNSESSION.
//   - Supabase CLOUD (session pooler :5432): SSL required, and the pooler caps ALL clients at 15.
//     Web pg+boss and worker pg+boss must sum under it, so cloud pg is a lean 3 (web 3+2, worker
//     3+3 = 11, ~4 headroom). Never run two workers against the pooler (2×6 + 5 = 17 > 15).
//
// The session pooler (:5432) supports prepared statements + LISTEN/NOTIFY (unlike the :6543
// transaction pooler); local direct connections support everything. Connects lazily; idle
// connections release after idle_timeout.
export const sql = postgres(env.DATABASE_URL, {
  max: isLocalDatabase ? 10 : 3,
  idle_timeout: 20,
  ssl: isLocalDatabase ? false : 'require',
});

export type Sql = typeof sql;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
