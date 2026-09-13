/**
 * Scheduler bootstrap (F1b).
 *
 * Kept intentionally thin so it can be lifted into its own worker process
 * later without touching business logic. Called once from src/index.ts
 * after DB connection is up.
 *
 * Env:
 *   FLAG_WORKER_CRON          cron expression, default '0 * * * *' (hourly at :00)
 *   FLAG_WORKER_RUN_ON_START  set to 'false' to skip the startup pass
 */
import cron from 'node-cron';
import { runFlagWorkerAllTenants } from './flag-worker';

export function startScheduler(): void {
  const schedule = process.env.FLAG_WORKER_CRON ?? '0 * * * *';
  const runOnStart = process.env.FLAG_WORKER_RUN_ON_START !== 'false';

  if (!cron.validate(schedule)) {
    console.error(`[scheduler] invalid FLAG_WORKER_CRON: "${schedule}" — worker NOT scheduled`);
    return;
  }

  if (runOnStart) {
    // Fire-and-forget so the HTTP server can bind immediately.
    void runFlagWorkerAllTenants().catch((err) => {
      console.error('[scheduler] startup flag-worker run failed:', err);
    });
  }

  cron.schedule(schedule, () => {
    void runFlagWorkerAllTenants().catch((err) => {
      console.error('[scheduler] cron flag-worker run failed:', err);
    });
  });

  console.log(
    `[scheduler] flag worker scheduled: cron="${schedule}" runOnStart=${runOnStart}`,
  );
}
