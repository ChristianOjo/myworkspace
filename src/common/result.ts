import { PoolClient } from 'pg';

export type Failure = {
  ok: false;
  http: 400 | 401 | 403 | 404 | 409 | 422 | 429;
  code: 'validation_error' | 'forbidden' | 'not_found' | 'invalid_state' | 'policy_violation' | 'slot_conflict' | 'unauthenticated' | 'rate_limited' | 'conflict';
  reason?: string;
  message: string;
};

export function fail(http: Failure['http'], code: Failure['code'], message: string, reason?: string): Failure {
  return { ok: false, http, code, message, reason };
}

export function isUuid(val: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

export function isManager(role: string): boolean {
  return role === 'location_manager' || role === 'org_admin';
}

export function ceilTo15(date: Date): Date {
  const ms = date.getTime();
  const remainder = ms % 900000;
  if (remainder === 0) return new Date(ms);
  return new Date(ms + 900000 - remainder);
}

export function floorTo15(date: Date): Date {
  const ms = date.getTime();
  return new Date(ms - (ms % 900000));
}

export async function loadActor(client: PoolClient, actorUserId: string): Promise<{ id: string; role: string; deactivated_at: Date | null } | Failure> {
  const res = await client.query(
    `SELECT id, role, deactivated_at FROM users WHERE id = $1`,
    [actorUserId]
  );
  if (res.rows.length === 0) {
    return fail(403, 'forbidden', 'Unknown staff member', 'unknown_actor');
  }
  const actor = res.rows[0];
  if (actor.deactivated_at !== null) {
    return fail(403, 'forbidden', 'Actor inactive', 'actor_inactive');
  }
  return actor;
}