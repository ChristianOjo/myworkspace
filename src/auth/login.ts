// src/auth/login.ts
import { Pool } from 'pg';
import { withOrg, resolveOrgId } from '../db/withOrg.js';
import { createSession } from './sessions.js';
import { verifyPassword, hashPassword } from './passwords.js';
import { fail, Failure } from '../common/result.js';

let dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHashCache) {
    dummyHashCache = await hashPassword('dummy-password-for-timing', { N: 1024 });
  }
  return dummyHashCache;
}

export async function login(
  pool: Pool, 
  input: { orgSlug: string; email: string; password: string }, 
  deps?: { now?: () => Date; verifyPassword?: typeof verifyPassword }
): Promise<{ ok: true; token: string; expiresAt: string; user: { id: string; email: string; fullName: string; role: string } } | Failure> {
  const slug = input.orgSlug.trim().toLowerCase();
  const email = input.email.trim();
  const now = deps?.now ? deps.now() : new Date();
  const vp = deps?.verifyPassword || verifyPassword;

  const orgId = await resolveOrgId(pool, slug);
  
  let user: { id: string; email: string; full_name: string; role: string; password_hash: string | null; deactivated_at: Date | null } | null = null;
  if (orgId) {
    user = await withOrg(pool, orgId, async (client) => {
      const res = await client.query(
        `SELECT id, email, full_name, role, password_hash, deactivated_at FROM users WHERE email = $1`,
        [email]
      );
      return res.rows.length > 0 ? res.rows[0] : null;
    });
  }

  const hash = user?.password_hash ?? await getDummyHash();
  const isValid = await vp(input.password, hash);

  if (!orgId || !user || user.deactivated_at !== null || user.password_hash === null || !isValid) {
    return fail(401, 'unauthenticated', 'Invalid credentials', 'invalid_credentials');
  }

  const session = await createSession(pool, { orgId, userId: user.id }, { now });
  
  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role
    }
  };
}