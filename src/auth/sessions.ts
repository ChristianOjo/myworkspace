import { Pool, PoolClient } from 'pg';
import crypto from 'node:crypto';
import { withOrg } from '../db/withOrg.js';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthResult {
  orgId: string;
  userId: string;
  email: string;
  fullName: string;
  role: string;
  sessionId: string;
  expiresAt: string;
}

export async function createSession(
  pool: Pool, 
  input: { orgId: string; userId: string }, 
  opts?: { now?: Date }
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const now = opts?.now || new Date();
  const randomPart = crypto.randomBytes(32).toString('base64url');
  const token = `${input.orgId}.${randomPart}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const result = await withOrg(pool, input.orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO sessions (org_id, user_id, token_hash, created_at, last_seen_at, expires_at) 
       VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
      [input.orgId, input.userId, tokenHash, now.toISOString(), expiresAt.toISOString()]
    );
    return { sessionId: res.rows[0].id };
  });

  return {
    token,
    sessionId: result.sessionId,
    expiresAt: expiresAt.toISOString()
  };
}

export async function authenticate(
  pool: Pool, 
  token: unknown, 
  opts?: { now?: Date }
): Promise<{ ok: true; auth: AuthResult } | { ok: false }> {
  if (typeof token !== 'string') return { ok: false };
  
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;
  if (!regex.test(token)) return { ok: false };

  const dotIndex = token.indexOf('.');
  const orgId = token.substring(0, dotIndex);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = opts?.now || new Date();

  try {
    const result = await withOrg(pool, orgId, async (client) => {
      const sessionRes = await client.query(
        `SELECT s.id, s.user_id, s.expires_at, s.last_seen_at, u.email, u.full_name, u.role, u.deactivated_at
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.deactivated_at IS NULL`,
        [tokenHash, now.toISOString()]
      );

      if (sessionRes.rows.length === 0) return null;
      
      const row = sessionRes.rows[0];
      
      // Update last_seen_at if older than 60 seconds
      const lastSeen = new Date(row.last_seen_at);
      const diffMs = now.getTime() - lastSeen.getTime();
      if (diffMs > 60000) {
        await client.query(
          `UPDATE sessions SET last_seen_at = $1 WHERE id = $2`,
          [now.toISOString(), row.id]
        );
      }

      return {
        orgId,
        userId: row.user_id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        sessionId: row.id,
        expiresAt: new Date(row.expires_at).toISOString()
      };
    });

    if (!result) return { ok: false };
    return { ok: true, auth: result };
  } catch {
    return { ok: false };
  }
}

export async function revokeSession(
  pool: Pool, 
  input: { orgId: string; sessionId: string }
): Promise<void> {
  await withOrg(pool, input.orgId, async (client) => {
    await client.query(
      `UPDATE sessions SET revoked_at = now() WHERE id = $1`,
      [input.sessionId]
    );
  });
}

export async function revokeUserSessions(
  client: PoolClient, 
  userId: string, 
  opts?: { exceptSessionId?: string; now?: Date }
): Promise<number> {
  const now = opts?.now || new Date();
  let query = `UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`;
  const params: any[] = [now.toISOString(), userId];
  
  if (opts?.exceptSessionId) {
    query += ` AND id != $3`;
    params.push(opts.exceptSessionId);
  }
  
  const res = await client.query(query, params);
  return res.rowCount || 0;
}