// src/auth/bootstrap.ts
import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { hashPassword, validatePassword } from './passwords.js';
import { createLocation, createResource } from '../catalog/catalog.js';
import { randomUUID } from 'node:crypto';

export async function createOrgWithAdmin(
  pool: Pool,
  input: { 
    orgName: string; 
    slug: string; 
    adminEmail: string; 
    adminName: string; 
    adminPassword?: string;
  }
): Promise<{ orgId: string; locationId: string; adminUserId: string; password: string }> {
  let password: string;
  
  if (input.adminPassword !== undefined) {
    const validation = validatePassword(input.adminPassword);
    if (!validation.ok) {
      const err = new Error('Invalid password');
      (err as any).reason = 'weak_password';
      throw err;
    }
    password = input.adminPassword;
  } else {
    password = `admin-${randomUUID()}`;
  }
  
  const hash = await hashPassword(password);
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const orgRes = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [input.orgName, input.slug]
    );
    const orgId = orgRes.rows[0].id;
    
    const userRes = await client.query(
      `INSERT INTO users (org_id, email, full_name, role, password_hash) 
       VALUES ($1, $2, $3, 'org_admin', $4) RETURNING id`,
      [orgId, input.adminEmail, input.adminName, hash]
    );
    const adminUserId = userRes.rows[0].id;
    
    const locRes = await client.query(
      `INSERT INTO locations (org_id, name, timezone, open_hour, close_hour) 
       VALUES ($1, 'Main', 'UTC', '08:00', '20:00') RETURNING id`,
      [orgId]
    );
    const locationId = locRes.rows[0].id;
    
    await client.query('COMMIT');
    
    return { orgId, locationId, adminUserId, password };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}