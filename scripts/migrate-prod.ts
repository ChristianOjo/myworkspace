// scripts/migrate-prod.ts
import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { setRolePassword } from '../src/ops/appPassword.js';

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
    const applied = await migrate(pool);
    console.log(`Applied ${applied.length} migration(s):`);
    applied.forEach(f => console.log(`  ${f}`));

    if (config.appUserPassword) {
      await setRolePassword(pool, 'app_user', config.appUserPassword);
      console.log('app_user password updated');
    } else if (config.nodeEnv === 'production') {
      console.warn('WARNING: APP_USER_PASSWORD not set. app_user still has the development password.');
      await pool.end();
      process.exit(1);
    }
    
    await pool.end();
    process.exit(0);
  } catch (err: any) {
    console.error('Migration failed:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();