import { env } from '@scriptreel/config';
import postgres from 'postgres';

// Single postgres.js pool over the Supabase session pooler (doc 05). The session
// pooler (:5432) supports prepared statements + LISTEN/NOTIFY, unlike the :6543
// transaction pooler. Connects lazily on first query.
export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  ssl: 'require',
});

export type Sql = typeof sql;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
