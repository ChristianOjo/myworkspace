import { Pool } from 'pg';
import { hashPassword, generatePassword, validatePassword } from './passwords.js';

export async function createOrgWithAdmin(
  ownerPool: Pool, 
  input: { 
    orgName: string; 
    slug: string; 
    adminEmail: string; 
    adminName: string; 
    adminPassword?: string;
    locationName?: string; 
    timezone?: string; 
    openHour?: string; 
    closeHour?: string; 
  }
): Promise<{ orgId: string; locationId: string; adminUserId: string; password: string }> {
  const slugRegex = /^[a-z0-9-]{2,60}$/;
  if (!slugRegex.test(input.slug)) {
    throw new Error(`Invalid slug format: ${input.slug}. Must be lowercase letters, digits and hyphens, 2 to 60 characters.`);
  }

  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');

    const orgCheck = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [input.slug]);
    if (orgCheck.rows.length > 0) {
      throw new Error(`Duplicate slug: ${input.slug}`);
    }

    const timezone = input.timezone || 'UTC';
    const tzCheck = await client.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [timezone]);
    if (tzCheck.rows.length === 0) {
      throw new Error('Invalid timezone');
    }

    const orgRes = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [input.orgName, input.slug]
    );
    const orgId = orgRes.rows[0].id;

    // locations and users use FORCE ROW LEVEL SECURITY, so the transaction must be scoped to the new org for the inserts to pass.
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

    const locRes = await client.query(
      `INSERT INTO locations (org_id, name, timezone, open_hour, close_hour) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, input.locationName || 'Main', timezone, input.openHour || '08:00', input.closeHour || '20:00']
    );
    const locationId = locRes.rows[0].id;

    let password: string;
    if (input.adminPassword !== undefined) {
      const problem = validatePassword(input.adminPassword);
      if (problem) {
        throw new Error('Admin password is too weak: use 10 to 200 characters');
      }
      password = input.adminPassword;
    } else {
      password = generatePassword();
    }
    const hashedPw = await hashPassword(password);

    const userRes = await client.query(
      `INSERT INTO users (org_id, email, full_name, role, password_hash) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, input.adminEmail, input.adminName, 'org_admin', hashedPw]
    );
    const adminUserId = userRes.rows[0].id;

    await client.query('COMMIT');
    return { orgId, locationId, adminUserId, password };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}