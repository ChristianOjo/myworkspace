// src/http/server.ts
import { createPool, createAppPool } from '../db/pool.js';
import { buildApp } from './app.js';
import { runSweepers } from '../jobs/sweepers.js';
import { createScheduler } from '../jobs/scheduler.js';
import { loadConfig } from '../config.js';

let config;
try {
  config = loadConfig();
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

const pool = createAppPool(config.appDatabaseUrl, { ssl: config.dbSsl, max: config.dbPoolMax });
const app = buildApp({ 
  pool, 
  corsOrigins: config.corsOrigins, 
  staticDir: config.staticDir, 
  production: config.nodeEnv === 'production',
  logger: config.nodeEnv === 'production' ? { level: 'info', redact: ['req.headers.authorization'] } : false
});

const port = config.port;
const host = config.host;

let scheduler: ReturnType<typeof createScheduler> | null = null;

app.listen({ port, host })
  .then(() => {
    console.log(`Server listening on ${host}:${port} [${config.nodeEnv}] static:${!!config.staticDir} scheduler:${config.schedulerEnabled}`);
    if (config.schedulerEnabled) {
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

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.message);
  process.exit(1);
});