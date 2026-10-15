import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { loadActor, isManager, fail, Failure, isUuid } from '../common/result.js';
import { hashPassword, validatePassword } from './passwords.js';
import { revokeUserSessions } from './sessions.js';

export async function listStaff(
  pool: Pool, 
  input: { orgId: string; actorUserId: string }
): Promise<{ ok: true; staff: Array<{ id: string; email: string; fullName: string; role: string; deactivatedAt: string | null; createdAt: string }> } | Failure> {
  if (!isUuid(input.actorUserId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;
      
      if (!isManager(actor.role)) {
        return fail(403, 'forbidden', 'Manager required', 'manager_required');
      }

      const res = await client.query(
        `SELECT id, email, full_name, role, deactivated_at, created_at 
         FROM users 
         ORDER BY full_name, id`
      );

      return {
        ok: true,
        staff: res.rows.map((row: any) => ({
          id: row.id,
          email: row.email,
          fullName: row.full_name,
          role: row.role,
          deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at).toISOString() : null,
          createdAt: new Date(row.created_at).toISOString()
        }))
      };
    });
  } catch (err) {
    throw err;
  }
}

export async function createStaff(
  pool: Pool, 
  input: { orgId: string; actorUserId: string; email: string; fullName: string; role: string; password: string }
): Promise<{ ok: true; user: { id: string; email: string; fullName: string; role: string; createdAt: string } } | Failure> {
  if (!isUuid(input.actorUserId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');

  const emailTrimmed = input.email.trim();
  if (!emailTrimmed.includes('@') || emailTrimmed.split('@').length !== 2 || emailTrimmed.length > 254 || /\s/.test(emailTrimmed)) {
    return fail(400, 'validation_error', 'Invalid email', 'invalid_email');
  }

  const nameTrimmed = input.fullName.trim();
  if (nameTrimmed.length < 1 || nameTrimmed.length > 200) {
    return fail(400, 'validation_error', 'Invalid name', 'invalid_name');
  }

  if (!['member', 'location_manager', 'org_admin'].includes(input.role)) {
    return fail(400, 'validation_error', 'Invalid role', 'invalid_role');
  }

  const pwErr = validatePassword(input.password);
  if (pwErr) {
    return fail(400, 'validation_error', 'Weak password', pwErr);
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      if (actor.role !== 'org_admin') {
        return fail(403, 'forbidden', 'Admin required', 'admin_required');
      }

      const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [emailTrimmed]);
      if (existing.rows.length > 0) {
        return fail(409, 'conflict', 'Email taken', 'email_taken');
      }

      const hashedPw = await hashPassword(input.password);

      const res = await client.query(
        `INSERT INTO users (org_id, email, full_name, role, password_hash) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, full_name, role, created_at`,
        [input.orgId, emailTrimmed, nameTrimmed, input.role, hashedPw]
      );

      const user = res.rows[0];

      await client.query(
        `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.orgId, actor.id, 'staff.create', 'user', user.id, JSON.stringify({ email: emailTrimmed, role: input.role })]
      );

      return {
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          createdAt: new Date(user.created_at).toISOString()
        }
      };
    });
  } catch (err) {
    throw err;
  }
}

export async function deactivateStaff(
  pool: Pool, 
  input: { orgId: string; actorUserId: string; targetUserId: string }
): Promise<{ ok: true } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.targetUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      if (actor.role !== 'org_admin') {
        return fail(403, 'forbidden', 'Admin required', 'admin_required');
      }

      if (actor.id === input.targetUserId) {
        return fail(422, 'policy_violation', 'Cannot deactivate self', 'cannot_deactivate_self');
      }

      const targetRes = await client.query(`SELECT id FROM users WHERE id = $1`, [input.targetUserId]);
      if (targetRes.rows.length === 0) {
        return fail(404, 'not_found', 'Staff member not found');
      }

      await client.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [input.targetUserId]);
      await revokeUserSessions(client, input.targetUserId);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.orgId, actor.id, 'staff.deactivate', 'user', input.targetUserId, JSON.stringify({})]
      );

      return { ok: true };
    });
  } catch (err) {
    throw err;
  }
}

export async function resetStaffPassword(
  pool: Pool, 
  input: { orgId: string; actorUserId: string; targetUserId: string; newPassword: string }
): Promise<{ ok: true } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.targetUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  const pwErr = validatePassword(input.newPassword);
  if (pwErr) {
    return fail(400, 'validation_error', 'Weak password', pwErr);
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      if (actor.role !== 'org_admin') {
        return fail(403, 'forbidden', 'Admin required', 'admin_required');
      }

      const targetRes = await client.query(`SELECT id FROM users WHERE id = $1`, [input.targetUserId]);
      if (targetRes.rows.length === 0) {
        return fail(404, 'not_found', 'Staff member not found');
      }

      const hashedPw = await hashPassword(input.newPassword);
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashedPw, input.targetUserId]);
      await revokeUserSessions(client, input.targetUserId);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.orgId, actor.id, 'staff.password_reset', 'user', input.targetUserId, JSON.stringify({})]
      );

      return { ok: true };
    });
  } catch (err) {
    throw err;
  }
}

export async function changeOwnPassword(
  pool: Pool, 
  input: { orgId: string; userId: string; currentPassword: string; newPassword: string; keepSessionId?: string }
): Promise<{ ok: true } | Failure> {
  if (!isUuid(input.userId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  const pwErr = validatePassword(input.newPassword);
  if (pwErr) {
    return fail(400, 'validation_error', 'Weak password', pwErr);
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const userRes = await client.query(
        `SELECT id, password_hash, deactivated_at FROM users WHERE id = $1`,
        [input.userId]
      );

      if (userRes.rows.length === 0 || userRes.rows[0].deactivated_at !== null) {
        return fail(403, 'forbidden', 'Unknown staff member', 'unknown_actor');
      }

      const user = userRes.rows[0];
      
      const { verifyPassword } = await import('./passwords.js');
      const isValid = await verifyPassword(input.currentPassword, user.password_hash);
      
      if (!isValid) {
        return fail(422, 'policy_violation', 'Wrong current password', 'wrong_current_password');
      }

      const hashedPw = await hashPassword(input.newPassword);
      await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashedPw, input.userId]);
      
      await revokeUserSessions(client, input.userId, { exceptSessionId: input.keepSessionId });

      await client.query(
        `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.orgId, input.userId, 'staff.password_change', 'user', input.userId, JSON.stringify({})]
      );

      return { ok: true };
    });
  } catch (err) {
    throw err;
  }
}