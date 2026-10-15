// test/auth-api.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool, createOrg, createUser, createStaff, createUserWithPassword, deactivateUser } from './helpers.js';
import { buildApp } from '../src/http/app.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';
import { verifyPassword } from '../src/auth/passwords.js';
import { Pool } from 'pg';

let clock = new Date('2030-01-07T09:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
  clock = new Date('2030-01-07T09:00:00Z');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('auth-api', () => {
  it('health check reports ok with a working database', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('login succeeds with slug, email in any case and password', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'TEST-ORG ', email: ' ADMIN@TEST.COM ', password }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.user.role).toBe('org_admin');
    expect(body.user.email).toBe('admin@test.com');
  });

  it('all login failures return an identical 401', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });

    const goneUserId = await createUserWithPassword(orgId, { email: 'gone@test.com', role: 'member', password: 'gone-password-1' });
    await deactivateUser(goneUserId);

    const ssoUserId = await createUser(orgId, 'sso@test.com');

    const cases = [
      { orgSlug: 'bad-slug', email: 'admin@test.com', password },
      { orgSlug: 'test-org', email: 'unknown@test.com', password },
      { orgSlug: 'test-org', email: 'admin@test.com', password: 'wrong-password' },
      { orgSlug: 'test-org', email: 'gone@test.com', password: 'gone-password-1' },
      { orgSlug: 'test-org', email: 'sso@test.com', password: 'any-password' },
    ];

    for (const c of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: c });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthenticated', reason: 'invalid_credentials', message: 'Invalid credentials' } });
    }
  });

  it('login verifies a password exactly once whether or not the account exists', async () => {
    let callCount = 0;
    const countingVerify = async (pass: string, hash: string | null) => {
      callCount++;
      return false;
    };

    const appCounting = buildApp({ pool: appPool, now: () => clock, verifyPassword: countingVerify });
    
    await appCounting.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'bad', email: 'e@e.com', password: 'p' } });
    expect(callCount).toBe(1);
    
    callCount = 0;
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });
    
    await appCounting.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'bad@test.com', password } });
    expect(callCount).toBe(1);
    
    callCount = 0;
    await appCounting.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password: 'wrong' } });
    expect(callCount).toBe(1);
    
    callCount = 0;
    await appCounting.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    expect(callCount).toBe(1);
    
    await appCounting.close();
  });

  it('login is rate limited per ip and account, and a success resets the account counter', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });
    await createUserWithPassword(orgId, { email: 'staff@example.com', role: 'member', password: 'staff-password-1' });

    let verifyCalls = 0;
    const countingVerify = async (pass: string, hash: string | null) => {
      verifyCalls++;
      return verifyPassword(pass, hash);
    };
    const appMock = buildApp({ pool: appPool, now: () => clock, verifyPassword: countingVerify });

    const adminWrongPayload = { orgSlug: 'test-org', email: 'admin@test.com', password: 'wrong' };
    const ip = '1.2.3.4';

    // 1. Five wrong-password attempts for the admin
    for (let i = 0; i < 5; i++) {
      verifyCalls = 0;
      const res = await appMock.inject({ method: 'POST', url: '/api/v1/auth/login', payload: adminWrongPayload, headers: { 'x-forwarded-for': ip } });
      expect(res.statusCode).toBe(401);
      expect(verifyCalls).toBe(1);
    }

    // 2. A sixth attempt with the admin's CORRECT password
    verifyCalls = 0;
    const res6 = await appMock.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/login', 
      payload: { orgSlug: 'test-org', email: 'admin@test.com', password }, 
      headers: { 'x-forwarded-for': ip } 
    });
    expect(res6.statusCode).toBe(429);
    expect(res6.json().error.code).toBe('rate_limited');
    expect(res6.headers['retry-after']).toBeDefined();
    expect(verifyCalls).toBe(0);

    // 3. 'staff@example.com' with its correct password from the same ip
    const resStaff = await appMock.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/login', 
      payload: { orgSlug: 'test-org', email: 'staff@example.com', password: 'staff-password-1' }, 
      headers: { 'x-forwarded-for': ip } 
    });
    expect(resStaff.statusCode).toBe(200);

    // 4. Advance the clock by 15 minutes + 1 second
    clock = new Date(clock.getTime() + 15 * 60 * 1000 + 1000);
    const resReset = await appMock.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/login', 
      payload: { orgSlug: 'test-org', email: 'admin@test.com', password }, 
      headers: { 'x-forwarded-for': ip } 
    });
    expect(resReset.statusCode).toBe(200);

    // 5. Reset behaviour on the staff account
    const staffWrongPayload = { orgSlug: 'test-org', email: 'staff@example.com', password: 'wrong' };
    for (let i = 0; i < 4; i++) {
      const res = await appMock.inject({ method: 'POST', url: '/api/v1/auth/login', payload: staffWrongPayload, headers: { 'x-forwarded-for': ip } });
      expect(res.statusCode).toBe(401);
    }
    const resStaffCorrect = await appMock.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/login', 
      payload: { orgSlug: 'test-org', email: 'staff@example.com', password: 'staff-password-1' }, 
      headers: { 'x-forwarded-for': ip } 
    });
    expect(resStaffCorrect.statusCode).toBe(200);
    for (let i = 0; i < 4; i++) {
      const res = await appMock.inject({ method: 'POST', url: '/api/v1/auth/login', payload: staffWrongPayload, headers: { 'x-forwarded-for': ip } });
      expect(res.statusCode).toBe(401);
    }

    await appMock.close();
  });

  it('me returns the current user and logout revokes the token', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token = loginRes.json().token;

    const meRes = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${token}` } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.id).toBe(adminUserId);

    const logoutRes = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { Authorization: `Bearer ${token}` } });
    expect(logoutRes.statusCode).toBe(204);

    const meRes2 = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${token}` } });
    expect(meRes2.statusCode).toBe(401);
  });

  it('protected routes return an identical 401 for missing, malformed, expired and revoked tokens', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });

    const check401 = async (headers: any) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
    };

    // 1. no Authorization header
    await check401({});

    // 2. 'Basic xyz'
    await check401({ Authorization: 'Basic xyz' });

    // 3. 'Bearer garbage'
    await check401({ Authorization: 'Bearer garbage' });

    // 4. an EXPIRED token
    const loginRes1 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token1 = loginRes1.json().token;
    const resMe1 = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${token1}` } });
    expect(resMe1.statusCode).toBe(200);

    clock = new Date(clock.getTime() + 12 * 60 * 60 * 1000 + 1000);
    await check401({ Authorization: `Bearer ${token1}` });

    // 5. a REVOKED token
    const loginRes2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token2 = loginRes2.json().token;
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { Authorization: `Bearer ${token2}` } });
    await check401({ Authorization: `Bearer ${token2}` });
  });

  it('validation errors use the standard error body', async () => {
    const resMissing = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });
    expect(resMissing.statusCode).toBe(400);
    expect(resMissing.json()).toEqual({ error: { code: 'validation_error', message: 'Invalid request' } });

    const resExtra = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'a', email: 'b@c.d', password: 'p', extra: 'field' } });
    expect(resExtra.statusCode).toBe(400);
    expect(resExtra.json()).toEqual({ error: { code: 'validation_error', message: 'Invalid request' } });
    
    const resNum = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'a', email: 123, password: 'p' } });
    expect(resNum.statusCode).toBe(400);
    expect(resNum.json()).toEqual({ error: { code: 'validation_error', message: 'Invalid request' } });

    const resMalformed = await app.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/login', 
      payload: '{bad',
      headers: { 'content-type': 'application/json' }
    });
    expect(resMalformed.statusCode).toBe(400);
    expect(resMalformed.json()).toEqual({ error: { code: 'validation_error', message: 'Invalid request' } });
  });

  it('unknown routes and unexpected errors use the standard bodies', async () => {
    const res404 = await app.inject({ method: 'GET', url: '/nope' });
    expect(res404.statusCode).toBe(404);
    expect(res404.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });

    const badPool = { 
      connect: async () => { throw new Error('boom-secret'); }, 
      query: async () => { throw new Error('boom-secret'); } 
    } as unknown as Pool;
    const badApp = buildApp({ pool: badPool });
    const res500 = await badApp.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'a', email: 'b@c.d', password: 'p' } });
    expect(res500.statusCode).toBe(500);
    expect(res500.json()).toEqual({ error: { code: 'internal_error', message: 'Something went wrong' } });
    expect(res500.body).not.toContain('boom-secret');
    await badApp.close();
  });

  it('every response carries no-store and nosniff headers', async () => {
    const resOk = await app.inject({ method: 'GET', url: '/health' });
    expect(resOk.headers['cache-control']).toBe('no-store');
    expect(resOk.headers['x-content-type-options']).toBe('nosniff');
    
    const res401 = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res401.headers['cache-control']).toBe('no-store');
    
    const res404 = await app.inject({ method: 'GET', url: '/nope' });
    expect(res404.headers['cache-control']).toBe('no-store');
  });

  it('changing your own password needs the current password and ends other sessions', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });
    
    const login1 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token1 = login1.json().token;
    
    const login2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token2 = login2.json().token;

    const resWrong = await app.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/password', 
      headers: { Authorization: `Bearer ${token1}` },
      payload: { currentPassword: 'wrong', newPassword: 'new-password-123' }
    });
    expect(resWrong.statusCode).toBe(422);

    const resWeak = await app.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/password', 
      headers: { Authorization: `Bearer ${token1}` },
      payload: { currentPassword: password, newPassword: 'short' }
    });
    expect(resWeak.statusCode).toBe(400);

    const resSuccess = await app.inject({ 
      method: 'POST', 
      url: '/api/v1/auth/password', 
      headers: { Authorization: `Bearer ${token1}` },
      payload: { currentPassword: password, newPassword: 'new-password-123' }
    });
    expect(resSuccess.statusCode).toBe(204);

    const resMe1 = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${token1}` } });
    expect(resMe1.statusCode).toBe(200);

    const resMe2 = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${token2}` } });
    expect(resMe2.statusCode).toBe(401);
    
    const loginOld = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    expect(loginOld.statusCode).toBe(401);
    
    const loginNew = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password: 'new-password-123' } });
    expect(loginNew.statusCode).toBe(200);
  });

  it('a staff member can log out one session without affecting another', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, {
      orgName: 'Test Org', slug: 'test-org', adminEmail: 'admin@test.com', adminName: 'Admin'
    });
    
    const login1 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token1 = login1.json().token;
    
    const login2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { orgSlug: 'test-org', email: 'admin@test.com', password } });
    const token2 = login2.json().token;

    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { Authorization: `Bearer ${token1}` } });

    const resMe2 = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${token2}` } });
    expect(resMe2.statusCode).toBe(200);
  });
});