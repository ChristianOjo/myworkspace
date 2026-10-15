import { createAppPool } from '../db/pool.js';
import { buildApp } from './app.js';
import { runSweepers } from '../jobs/sweepers.js';
import { createScheduler } from '../jobs/scheduler.js';

const pool = createAppPool();
const corsOriginsEnv = process.env.CORS_ORIGINS;
const corsOrigins = corsOriginsEnv ? corsOriginsEnv.split(',').map(s => s.trim()).filter(s => s.length > 0) : undefined;

const app = buildApp({ pool, corsOrigins });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

let scheduler: ReturnType<typeof createScheduler> | null = null;

app.listen({ port, host })
  .then(() => {
    console.log(`Server listening on ${host}:${port}`);
    if (process.env.SCHEDULER !== 'off') {
      scheduler = createScheduler({
        run: () => runSweepers(pool),
        intervalMs: 60000,
        onError: (err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
        }
      });
      scheduler.start();
    }
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });

const shutdown = async () => {
  if (scheduler) scheduler.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);