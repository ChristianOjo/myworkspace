import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    const shortPassword = '123456789012345';
    
    try {
      await testPool.query(`CREATE ROLE ${roleName} WITH LOGIN PASSWORD 'initial'`);
      
      await setRolePassword(testPool, roleName, newPassword);
      
      const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test');
      
      const newUrl = new URL(base.toString());
      newUrl.username = roleName;
      newUrl.password = newPassword;
      
      const newPool = new Pool({ connectionString: newUrl.toString(), max: 1 });
      try {
        const res1 = await newPool.query('SELECT 1');
        expect(res1.rows[0]).toBeDefined();
      } finally {
        await newPool.end();
      }
      
      const wrongUrl = new URL(base.toString());
      wrongUrl.username = roleName;
      wrongUrl.password = wrongPassword;
      
      const wrongPool = new Pool({ connectionString: wrongUrl.toString(), max: 1 });
      try {
        let caughtErr: any = null;
        try {
          await wrongPool.query('SELECT 1');
        } catch (e: any) {
          caughtErr = e;
        }
        expect(caughtErr).not.toBeNull();
        expect(caughtErr.code).toBe('28P01');
      } finally {
        await wrongPool.end();
      }
      
      let badRoleErr: any = null;
      try {
        await setRolePassword(testPool, 'INVALID-ROLE', newPassword);
      } catch (e: any) {
        badRoleErr = e;
      }
      expect(badRoleErr).not.toBeNull();
      expect(badRoleErr.message).toMatch(/Invalid role name/);
      expect(badRoleErr.message).not.toContain(newPassword);
      
      let shortPassErr: any = null;
      try {
        await setRolePassword(testPool, roleName, shortPassword);
      } catch (e: any) {
        shortPassErr = e;
      }
      expect(shortPassErr).not.toBeNull();
      expect(shortPassErr.message).toMatch(/Password must be between 16 and 200 characters/);
      expect(shortPassErr.message).not.toContain(shortPassword);
      
    } finally {
      await testPool.query(`DROP ROLE IF EXISTS ${roleName}`);
    }
  });

  it('migrate runs from any working directory with MIGRATIONS_DIR', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'migrate-test-'));
    const noopFile = path.join(tempDir, 'zz_test_noop.sql');
    writeFileSync(noopFile, 'SELECT 1;');
    
    const originalMigrationsDir = process.env.MIGRATIONS_DIR;
    process.env.MIGRATIONS_DIR = tempDir;
    
    try {
      const applied1 = await migrate(testPool);
      expect(applied1).toEqual(['zz_test_noop.sql']);
      
      const applied2 = await migrate(testPool);
      expect(applied2).toEqual([]);
    } finally {
      if (originalMigrationsDir !== undefined) {
        process.env.MIGRATIONS_DIR = originalMigrationsDir;
      } else {
        delete process.env.MIGRATIONS_DIR;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});