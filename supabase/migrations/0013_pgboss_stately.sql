-- 0013_pgboss_stately.sql — make the pipeline queue's singletonKey actually dedupe.
--
-- enqueuePipeline sends every job with singletonKey = projectId, and both createQueue callers
-- (apps/web/lib/queue.ts, apps/worker/src/index.ts) plus the worker's stuck-job reconciler are
-- built on the premise that this makes a re-send for a project that already has a live job a
-- no-op. It did not: pg-boss's create_queue defaulted the queue to policy 'standard', which builds
-- NONE of the singleton unique indexes, so `send(..., {singletonKey})` never conflicted and every
-- call inserted another row. Measured on this database: one project held 3 live pipeline jobs
-- (1 active + 2 created); cancelling aborted one while a duplicate restarted on the next reconciler
-- tick, and a second project's job queued behind the stuck one and never ran.
--
-- The code now passes policy 'stately' (one job per (queue, singletonKey) in each state ≤ active),
-- but create_queue is ON CONFLICT DO NOTHING, so it will NOT change a queue that already exists.
-- This migration flips the existing row. The four per-policy partial indexes (short/singleton/
-- stately/throttle) are all created with the partition regardless of the active policy, so the
-- stately index is already present and starts enforcing as soon as new jobs carry policy='stately'
-- (pg-boss copies the queue's policy onto each job at insert).
--
-- Guarded on the table's existence so a fresh clone — where migrations run BEFORE pg-boss ever
-- starts and creates its schema — treats this as a no-op (the code makes that queue stately at
-- birth). Scoped to the 'standard' row so it never disturbs a hand-tuned policy.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'pgboss' and table_name = 'queue'
  ) then
    update pgboss.queue set policy = 'stately'
    where name = 'pipeline' and policy = 'standard';
  end if;
end $$;
