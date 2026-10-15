import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool } from './helpers.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';
import { buildApp } from '../src/http/app.js';

let clock = new Date('2030-01-07T09:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('bootstrap', () => {
  it('createOrgWithAdmin creates an org, a location and an admin who can log in', async () => {
    const result = await createOrgWithAdmin(testPool, {
      orgName: 'Bootstrap Org',
      slug: 'bootstrap-org',
      adminEmail: 'admin@boot.com',
      adminName: 'Boot Admin'
    });

    expect(result.orgId).toBeDefined();
    expect(result.locationId).toBeDefined();
    expect(result.adminUserId).toBeDefined();
    expect(result.password).toHaveLength(20);

    const loc = await testPool.query('SELECT * FROM locations WHERE id = $1', [result.locationId]);
    expect(loc.rows[0].name).toBe('Main');
    expect(loc.rows[0].timezone).toBe('UTC');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'bootstrap-org', email: 'admin@boot.com', password: result.password }
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().user.role).toBe('org_admin');
  });

  it('a duplicate slug is rejected with a clear error and creates nothing', async () => {
    await createOrgWithAdmin(testPool, { orgName: 'First', slug: 'dupe', adminEmail: 'a@a.a', adminName: 'A' });
    
    await expect(createOrgWithAdmin(testPool, { orgName: 'Second', slug: 'dupe', adminEmail: 'b@b.b', adminName: 'B' })).rejects.toThrow('Duplicate slug');
    
    const orgCount = await testPool.query('SELECT count(*) FROM organizations WHERE slug = $1', ['dupe']);
    expect(Number(orgCount.rows[0].count)).toBe(1);
    
    await expect(createOrgWithAdmin(testPool, { orgName: 'Bad', slug: 'Bad Slug!', adminEmail: 'c@c.c', adminName: 'C' })).rejects.toThrow('Invalid slug');
  });

  it('the generated password is returned once and only its hash is stored', async () => {
    const result = await createOrgWithAdmin(testPool, { orgName: 'Hash Org', slug: 'hash-org', adminEmail: 'h@h.h', adminName: 'H' });
    const user = await testPool.query('SELECT password_hash FROM users WHERE id = $1', [result.adminUserId]);
    expect(user.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(user.rows[0].password_hash).not.toContain(result.password);
  });
});