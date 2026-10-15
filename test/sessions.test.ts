import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool, createOrg, createUser, getSessionRows } from './helpers.js';
import { createSession, authenticate, revokeSession } from '../src/auth/sessions.js';
import { withOrg } from '../src/db/withOrg.js';
import { Pool } from 'pg';

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await appPool.end();
});

describe('sessions', () => {
  it('a session token authenticates until it expires', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const T = new Date('2030-01-07T09:00:00Z');
    const { token } = await createSession(appPool, { orgId, userId }, { now: T });

    const res1 = await authenticate(appPool, token, { now: new Date(T.getTime() + 11 * 60 * 60 * 1000 + 59 * 60 * 1000) });
    expect(res1.ok).toBe(true);

    const res2 = await authenticate(appPool, token, { now: new Date(T.getTime() + 12 * 60 * 60 * 1000) });
    expect(res2.ok).toBe(false);
  });

  it('only the hash of the token is stored', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const { token } = await createSession(appPool, { orgId, userId });
    
    const rows = await getSessionRows(orgId);
    expect(rows.length).toBe(1);
    const hash = rows[0].token_hash;
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('a revoked session no longer authenticates', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const { token, sessionId } = await createSession(appPool, { orgId, userId });
    
    await revokeSession(appPool, { orgId, sessionId });
    const res = await authenticate(appPool, token);
    expect(res.ok).toBe(false);
  });

  it('a deactivated user\'s sessions stop working', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const { token } = await createSession(appPool, { orgId, userId });
    
    await testPool.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [userId]);
    const res = await authenticate(appPool, token);
    expect(res.ok).toBe(false);
  });

  it('malformed tokens fail without touching the database', async () => {
    const badPool = new Pool({ connect: async () => { throw new Error('boom'); } });
    const tokens = ['garbage', '', 'abc.def', '00000000-0000-0000-0000-000000000000.x', 123, null];
    
    for (const t of tokens) {
      const res = await authenticate(badPool, t);
      expect(res).toEqual({ ok: false });
    }
    await badPool.end();
  });

  it('a token from org A cannot authenticate with org B\'s prefix', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const userIdA = await createUser(orgA);
    const { token } = await createSession(appPool, { orgId: orgA, userId: userIdA });
    
    const parts = token.split('.');
    const fakeToken = `${orgB}.${parts[1]}`;
    const res = await authenticate(appPool, fakeToken);
    expect(res.ok).toBe(false);
  });

  it('last_seen_at is updated at most once a minute', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const T = new Date('2030-01-07T09:00:00Z');
    const { token } = await createSession(appPool, { orgId, userId }, { now: T });
    
    await authenticate(appPool, token, { now: new Date(T.getTime() + 30000) });
    let rows = await getSessionRows(orgId);
    expect(new Date(rows[0].last_seen_at).getTime()).toBe(T.getTime());

    await authenticate(appPool, token, { now: new Date(T.getTime() + 61000) });
    rows = await getSessionRows(orgId);
    expect(new Date(rows[0].last_seen_at).getTime()).toBe(T.getTime() + 61000);
  });

  it('sessions are isolated by row-level security', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const userA = await createUser(orgA);
    await createSession(appPool, { orgId: orgA, userId: userA });

    await withOrg(appPool, orgB, async (client) => {
      const res = await client.query('SELECT count(*) FROM sessions');
      expect(Number(res.rows[0].count)).toBe(0);
    });

    const resNoCtx = await appPool.query('SELECT count(*) FROM sessions');
    expect(Number(resNoCtx.rows[0].count)).toBe(0);
  });
});