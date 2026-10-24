// scripts/preflight.ts
import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { runPreflight } from '../src/ops/preflight.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  const pool = createPool(config.databaseUrl, { ssl: config.dbSsl });
  
  try {
    const checks = await runPreflight(pool);
    let hasFailure = false;
    
    for (const check of checks) {
      const status = check.ok ? 'PASS' : 'FAIL';
      console.log(`${status}: ${check.name}`);
      if (!check.ok) {
        console.log(`  ${check.detail}`);
        hasFailure = true;
      }
    }
    
    await pool.end();
    process.exit(hasFailure ? 1 : 0);
  } catch (err: any) {
    console.error('Preflight failed:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();