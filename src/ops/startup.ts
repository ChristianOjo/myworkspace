// src/ops/startup.ts
import { createPool } from '../db/pool.js';
import { runPreflight as defaultRunPreflight } from './preflight.js';
import { migrate as defaultMigrate } from '../db/migrate.js';
import { setRolePassword as defaultSetRolePassword } from './appPassword.js';
import { createOrgWithAdmin as defaultCreateOrgWithAdmin } from '../auth/bootstrap.js';
import { Config } from '../config.js';

export async function runStartupTasks(
  config: Config,
  log: (line: string) => void,
  deps?: {
    runPreflight?: typeof defaultRunPreflight;
    migrate?: typeof defaultMigrate;
    setRolePassword?: typeof defaultSetRolePassword;
    createOrgWithAdmin?: typeof defaultCreateOrgWithAdmin;
  }
): Promise<void> {
  if (!config.migrateOnStart && !config.bootstrap) {
    return;
  }

  const runPreflight = deps?.runPreflight || defaultRunPreflight;
  const migrate = deps?.migrate || defaultMigrate;
  const setRolePassword = deps?.setRolePassword || defaultSetRolePassword;
  const createOrgWithAdmin = deps?.createOrgWithAdmin || defaultCreateOrgWithAdmin;

  const pool = createPool(config.databaseUrl, { ssl: config.dbSsl, max: 2 });
  
  try {
    if (config.migrateOnStart) {
      const checks = await runPreflight(pool);
      let hasFailure = false;
      
      for (const check of checks) {
        if (check.ok) {
          log(`PASS ${check.name}`);
        } else {
          log(`FAIL ${check.name}: ${check.detail}`);
          hasFailure = true;
        }
      }
      
      if (hasFailure) {
        throw new Error('Preflight failed, see the lines above');
      }
      
      const applied = await migrate(pool);
      if (applied.length > 0) {
        log(`Applied ${applied.length} migration(s):`);
        applied.forEach(f => log(`  ${f}`));
      } else {
        log('no new migrations');
      }
      
      if (config.appUserPassword) {
        await setRolePassword(pool, 'app_user', config.appUserPassword);
        log('app_user password updated');
      } else if (config.nodeEnv === 'production') {
        throw new Error('APP_USER_PASSWORD is required in production');
      }
    }
    
    if (config.bootstrap) {
      const checkRes = await pool.query(
        `SELECT 1 FROM organizations WHERE slug = $1`,
        [config.bootstrap.slug]
      );
      
      if (checkRes.rows.length > 0) {
        log(`bootstrap: organisation ${config.bootstrap.slug} already exists, skipping`);
      } else {
        await createOrgWithAdmin(pool, {
          orgName: config.bootstrap.orgName,
          slug: config.bootstrap.slug,
          adminEmail: config.bootstrap.adminEmail,
          adminName: config.bootstrap.adminName,
          adminPassword: config.bootstrap.adminPassword
        });
        log(`bootstrap: created organisation ${config.bootstrap.slug}`);
      }
    }
  } finally {
    await pool.end();
  }
}