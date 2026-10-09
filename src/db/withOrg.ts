// src/db/withOrg.ts
import { Pool, PoolClient } from 'pg';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withOrg<T>(pool: Pool, orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!UUID_REGEX.test(orgId)) {
    throw new Error("invalid org id");
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

export async function resolveOrgId(pool: Pool, slug: string): Promise<string | null> {
  const res = await pool.query('SELECT org_id_by_slug($1) AS id', [slug]);
  return res.rows[0]?.id || null;
}