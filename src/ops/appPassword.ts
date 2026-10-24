// src/ops/appPassword.ts
import { Pool } from 'pg';

export async function setRolePassword(pool: Pool, role: string, password: string): Promise<void> {
  const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;
  if (!rolePattern.test(role)) {
    throw new Error('Invalid role name');
  }
  
  if (password.length < 16 || password.length > 200) {
    throw new Error('Password must be between 16 and 200 characters');
  }

  const client = await pool.connect();
  try {
    const formatRes = await client.query(
      `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1, $2) AS stmt`,
      [role, password]
    );
    const stmt = formatRes.rows[0].stmt;
    await client.query(stmt);
  } finally {
    client.release();
  }
}