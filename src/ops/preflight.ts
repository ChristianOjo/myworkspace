// src/ops/preflight.ts
import { Pool } from 'pg';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runPreflight(pool: Pool): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  try {
    const versionRes = await pool.query(`SELECT current_setting('server_version_num')::int AS version`);
    const version = versionRes.rows[0].version;
    checks.push({
      name: 'PostgreSQL version >= 16',
      ok: version >= 160000,
      detail: version >= 160000 ? `Version ${version}` : `Version ${version} is too old, need >= 160000`
    });
  } catch (err: any) {
    checks.push({
      name: 'PostgreSQL version >= 16',
      ok: false,
      detail: `Failed to query version: ${err.message}`
    });
  }

  try {
    const extRes = await pool.query(`
      SELECT name FROM pg_available_extensions 
      WHERE name IN ('btree_gist', 'citext', 'pgcrypto')
    `);
    const available = new Set(extRes.rows.map((r: any) => r.name));
    const required = ['btree_gist', 'citext', 'pgcrypto'];
    const missing = required.filter(e => !available.has(e));
    
    checks.push({
      name: 'Required extensions available',
      ok: missing.length === 0,
      detail: missing.length === 0 
        ? 'All required extensions available' 
        : `Missing: ${missing.join(', ')}`
    });
  } catch (err: any) {
    checks.push({
      name: 'Required extensions available',
      ok: false,
      detail: `Failed to query extensions: ${err.message}`
    });
  }

  try {
    const roleRes = await pool.query(`
      SELECT rolsuper OR rolcreaterole AS can_create 
      FROM pg_roles 
      WHERE rolname = current_user
    `);
    const canCreate = roleRes.rows[0]?.can_create || false;
    
    checks.push({
      name: 'Current user can create extensions and roles',
      ok: canCreate,
      detail: canCreate 
        ? 'User has required privileges' 
        : 'User lacks privileges. Manual fallback: create role app_user with LOGIN NOSUPERUSER NOBYPASSRLS before migrating'
    });
  } catch (err: any) {
    checks.push({
      name: 'Current user can create extensions and roles',
      ok: false,
      detail: `Failed to query role: ${err.message}`
    });
  }

  try {
    const appUserRes = await pool.query(`
      SELECT 1 FROM pg_roles WHERE rolname = 'app_user'
    `);
    const appUserExists = appUserRes.rows.length > 0;
    
    const roleRes = await pool.query(`
      SELECT rolsuper OR rolcreaterole AS can_create 
      FROM pg_roles 
      WHERE rolname = current_user
    `);
    const canCreate = roleRes.rows[0]?.can_create || false;
    
    checks.push({
      name: 'app_user role exists or can be created',
      ok: appUserExists || canCreate,
      detail: appUserExists 
        ? 'app_user role exists' 
        : canCreate 
          ? 'app_user does not exist but can be created'
          : 'app_user does not exist and cannot be created'
    });
  } catch (err: any) {
    checks.push({
      name: 'app_user role exists or can be created',
      ok: false,
      detail: `Failed to check app_user: ${err.message}`
    });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('CREATE TABLE preflight_test_temp (id int)');
      await client.query('DROP TABLE preflight_test_temp');
      checks.push({
        name: 'Can create and drop tables in public schema',
        ok: true,
        detail: 'CREATE and DROP successful'
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    checks.push({
      name: 'Can create and drop tables in public schema',
      ok: false,
      detail: `Failed: ${err.message}`
    });
  }

  return checks;
}