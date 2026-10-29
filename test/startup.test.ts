// test/startup.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { testPool } from './helpers.js';
import { runStartupTasks } from '../src/ops/startup.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createAppPool } from '../src/db/pool.js';

describe('startup', () => {
  beforeEach(async () => {
    await testPool.query('TRUNCATE organizations CASCADE');
  });

  it('does nothing when both features are off', async () => {
    const config = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test'
    });
    
    const logs: string[] = [];
    await runStartupTasks(config, (line) => logs.push(line), {
      migrate: async () => { throw new Error('Should not be called'); },
      createOrgWithAdmin: async () => { throw new Error('Should not be called'); }
    });
    
    expect(logs).toEqual([]);
  });

  it('bootstraps an organisation once and the admin can log in', async () => {
    const config = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test',
      BOOTSTRAP_ORG_NAME: 'Test Org',
      BOOTSTRAP_ORG_SLUG: 'test-startup',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@startup.test',
      BOOTSTRAP_ADMIN_NAME: 'Admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'password123456'
    });
    
    const logs: string[] = [];
    await runStartupTasks(config, (line) => logs.push(line));
    
    expect(logs.some(l => l.includes('bootstrap: created organisation test-startup'))).toBe(true);
    
    const orgCheck = await testPool.query(`SELECT id FROM organizations WHERE slug = 'test-startup'`);
    expect(orgCheck.rows.length).toBe(1);
    
    const locCheck = await testPool.query(`SELECT id FROM locations WHERE org_id = $1`, [orgCheck.rows[0].id]);
    expect(locCheck.rows.length).toBe(1);
    
    const userCheck = await testPool.query(`SELECT id, role FROM users WHERE org_id = $1 AND email = 'admin@startup.test'`, [orgCheck.rows[0].id]);
    expect(userCheck.rows.length).toBe(1);
    expect(userCheck.rows[0].role).toBe('org_admin');
    
    const appPool = createAppPool(process.env.TEST_APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace_test');
    const app = buildApp({ pool: appPool });
    
    try {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          orgSlug: 'test-startup',
          email: 'admin@startup.test',
          password: 'password123456'
        }
      });
      expect(loginRes.statusCode).toBe(200);
    } finally {
      await app.close();
      await appPool.end();
    }
    
    const logs2: string[] = [];
    await runStartupTasks(config, (line) => logs2.push(line));
    expect(logs2.some(l => l.includes('bootstrap: organisation test-startup already exists, skipping'))).toBe(true);
    
    const orgCheck2 = await testPool.query(`SELECT count(*) FROM organizations WHERE slug = 'test-startup'`);
    expect(Number(orgCheck2.rows[0].count)).toBe(1);
  });

  it('a failing preflight stops startup with a clear message and no password', async () => {
    const password = 'supersecretpassword123';
    const config = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test',
      RUN_MIGRATIONS_ON_START: 'true',
      BOOTSTRAP_ORG_NAME: 'Test Org',
      BOOTSTRAP_ORG_SLUG: 'test-fail',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@fail.test',
      BOOTSTRAP_ADMIN_NAME: 'Admin',
      BOOTSTRAP_ADMIN_PASSWORD: password
    });
    
    const logs: string[] = [];
    let migrateCalled = false;
    let createOrgCalled = false;
    
    try {
      await runStartupTasks(config, (line) => logs.push(line), {
        runPreflight: async () => [
          { name: 'Test check', ok: false, detail: 'Failed' }
        ],
        migrate: async () => {
          migrateCalled = true;
          return [];
        },
        createOrgWithAdmin: async () => {
          createOrgCalled = true;
          return { orgId: '', locationId: '', adminUserId: '', password: '' };
        }
      });
      throw new Error('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('Preflight failed');
      expect(err.message).not.toContain(password);
    }
    
    expect(logs.some(l => l.includes('FAIL'))).toBe(true);
    expect(logs.every(l => !l.includes(password))).toBe(true);
    expect(migrateCalled).toBe(false);
    expect(createOrgCalled).toBe(false);
  });

  it('sets the app role password through the injected function without logging it', async () => {
    const password = 'newapppassword123456';
    const config = loadConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test',
      RUN_MIGRATIONS_ON_START: 'true',
      APP_USER_PASSWORD: password
    });
    
    const logs: string[] = [];
    let setRoleCalled = false;
    let setRoleArgs: any[] = [];
    
    await runStartupTasks(config, (line) => logs.push(line), {
      runPreflight: async () => [
        { name: 'Test check', ok: true, detail: 'OK' }
      ],
      migrate: async () => [],
      setRolePassword: async (pool, role, pass) => {
        setRoleCalled = true;
        setRoleArgs = [role, pass];
      }
    });
    
    expect(setRoleCalled).toBe(true);
    expect(setRoleArgs[0]).toBe('app_user');
    expect(setRoleArgs[1]).toBe(password);
    expect(logs.some(l => l.includes('app_user password updated'))).toBe(true);
    expect(logs.every(l => !l.includes(password))).toBe(true);
  });
});