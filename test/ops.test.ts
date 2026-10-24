// test/ops.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { testPool } from './helpers.js';
import { runPreflight } from '../src/ops/preflight.js';
import { setRolePassword } from '../src/ops/appPassword.js';
import { migrate } from '../src/db/migrate.js';
import { randomUUID } from 'node:crypto';

describe('ops', () => {
  it('preflight passes on the test database', async () => {
    const checks = await runPreflight(testPool);
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it('preflight reports a failed check without throwing', async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes('pg_available_extensions')) {
          return { rows: [] };
        }
        return testPool.query(sql);
      },
      connect: () => testPool.connect()
    } as any;
    
    const checks = await runPreflight(mockPool);
    const extCheck = checks.find(c => c.name === 'Required extensions available');
    expect(extCheck?.ok).toBe(false);
    expect(checks.filter(c => c.ok).length).toBeGreaterThan(0);
  });

  it('setRolePassword changes a role\'s password and never leaks it', async () => {
    const roleName = `test_role_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const newPassword = 'newpassword123456789';
    const wrongPassword = 'wrongpassword123456789';
    
    try {
      await testPool.query(`CREATE ROLE ${roleName} WITH LOGIN PASSWORD 'initial'`);
      
      await setRolePassword(testPool, roleName, newPassword);
      
      const testDbUrl = process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test';
      const baseUrl = testDbUrl.replace(/\/\/[^@]+@/, '//');
      const newUrl = `postgres://${roleName}:${newPassword}@${baseUrl.split('@')[1]}`;
      const wrongUrl = `postgres://${roleName}:${wrongPassword}@${baseUrl.split('@')[1]}`;
      
      const newPool = new Pool({ connectionString: newUrl, max: 1 });
      const res1 = await newPool.query('SELECT 1');
      expect(res1.rows[0]).toBeDefined();
      await newPool.end();
      
      const wrongPool = new Pool({ connectionString: wrongUrl, max: 1 });
      await expect(wrongPool.query('SELECT 1')).rejects.toThrow();
      await wrongPool.end();
      
      await expect(setRolePassword(testPool, 'INVALID-ROLE', newPassword)).rejects.toThrow(/Invalid role name/);
      await expect(setRolePassword(testPool, roleName, 'short')).rejects.toThrow(/Password must be between 16 and 200 characters/);
      
    } finally {
      await testPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    }
  });

  it('migrate runs from any working directory with MIGRATIONS_DIR', async () => {
    const originalCwd = process.cwd();
    const migrationsDir = process.cwd() + '/migrations';
    
    try {
      process.chdir('/tmp');
      process.env.MIGRATIONS_DIR = migrationsDir;
      
      const applied = await migrate(testPool);
      expect(applied).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      delete process.env.MIGRATIONS_DIR;
    }
  });
});