// src/auth/customers.ts
// Public self-service registration for the customer portal.
// Staff accounts (org_admin, location_manager, member) are still created by an
// admin; only 'customer' accounts can be created through this public endpoint.
import { Pool } from 'pg';
import { withOrg, resolveOrgId } from '../db/withOrg.js';
import { createSession } from './sessions.js';
import { hashPassword, validatePassword } from './passwords.js';
import { fail, Failure } from '../common/result.js';

export interface CustomerProfile {
  id: string;
  email: string;
  fullName: string;
  role: 'customer';
  phone: string | null;
  company: string | null;
}

export type RegisterResult =
  | {
      ok: true;
      token: string;
      expiresAt: string;
      user: CustomerProfile;
    }
  | Failure;

function isValidEmail(email: string): boolean {
  return email.includes('@') && email.split('@').length === 2 && email.length <= 254 && !/\s/.test(email);
}

export async function registerCustomer(
  pool: Pool,
  input: { orgSlug: string; fullName: string; email: string; password: string; phone?: string; company?: string },
  opts?: { now?: Date }
): Promise<RegisterResult> {
  const slug = (input.orgSlug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) {
    return fail(400, 'validation_error', 'Invalid organisation slug', 'invalid_org_slug');
  }

  const email = (input.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return fail(400, 'validation_error', 'Invalid email', 'invalid_email');
  }

  const fullName = (input.fullName || '').trim();
  if (fullName.length < 1 || fullName.length > 200) {
    return fail(400, 'validation_error', 'Invalid name', 'invalid_name');
  }

  const pwErr = validatePassword(input.password);
  if (pwErr) {
    return fail(400, 'validation_error', 'Weak password', pwErr);
  }

  let phone: string | null = null;
  if (input.phone !== undefined && input.phone !== null && String(input.phone).trim() !== '') {
    phone = String(input.phone).trim();
    if (phone.length < 1 || phone.length > 50) {
      return fail(400, 'validation_error', 'Invalid phone', 'invalid_phone');
    }
  }

  let company: string | null = null;
  if (input.company !== undefined && input.company !== null && String(input.company).trim() !== '') {
    company = String(input.company).trim();
    if (company.length > 200) {
      return fail(400, 'validation_error', 'Invalid company name', 'invalid_company');
    }
  }

  const orgId = await resolveOrgId(pool, slug);
  if (!orgId) {
    return fail(404, 'not_found', 'Organisation not found', 'unknown_org');
  }

  const now = opts?.now || new Date();

  const created = await withOrg(pool, orgId, async (client) => {
    const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (existing.rows.length > 0) {
      return fail(409, 'conflict', 'Email taken', 'email_taken') as Failure;
    }

    const hashedPw = await hashPassword(input.password);

    const res = await client.query(
      `INSERT INTO users (org_id, email, full_name, role, password_hash, phone, company)
       VALUES ($1, $2, $3, 'customer', $4, $5, $6)
       RETURNING id, email, full_name, phone, company`,
      [orgId, email, fullName, hashedPw, phone, company]
    );
    const row = res.rows[0];

    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
       VALUES ($1, $2, 'customer.register', 'user', $3, $4)`,
      [orgId, row.id, row.id, JSON.stringify({ email, phone, company })]
    );

    return { id: row.id, email: row.email, fullName: row.full_name, phone: row.phone, company: row.company } as const;
  });

  if (!('id' in created)) return created;

  // The session row references the (now committed) user, so it is created after
  // the registration transaction has closed.
  const session = await createSession(pool, { orgId, userId: created.id }, { now });

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: created.id,
      email: created.email,
      fullName: created.fullName,
      role: 'customer',
      phone: created.phone,
      company: created.company
    }
  };
}
