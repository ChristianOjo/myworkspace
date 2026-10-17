// src/catalog/catalog.ts
import { Pool } from 'pg';
import crypto from 'node:crypto';
import { withOrg } from '../db/withOrg.js';
import { loadActor, fail, Failure, isUuid, isManager } from '../common/result.js';

function isValidTimeFormat(t: string): boolean {
  return /^([01]\d|2[0-3]):(00|15|30|45)$/.test(t);
}

function isValidIso8601WithTz(t: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(t);
}

export async function createLocation(
  pool: Pool,
  input: { orgId: string; actorUserId: string; name: string; timezone: string; openHour: string; closeHour: string },
  opts?: { now?: Date }
): Promise<{ ok: true; location: { id: string; name: string; timezone: string; openHour: string; closeHour: string } } | Failure> {
  if (!isUuid(input.actorUserId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 200) {
    return fail(400, 'validation_error', 'Invalid name', 'invalid_name');
  }
  if (!isValidTimeFormat(input.openHour) || !isValidTimeFormat(input.closeHour) || input.openHour >= input.closeHour) {
    return fail(400, 'validation_error', 'Invalid hours', 'invalid_hours');
  }

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;
    if (actor.role !== 'org_admin') return fail(403, 'forbidden', 'Admin required', 'admin_required');

    const tzRes = await client.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [input.timezone]);
    if (tzRes.rows.length === 0) return fail(400, 'validation_error', 'Invalid timezone', 'invalid_timezone');

    const res = await client.query(
      `INSERT INTO locations (org_id, name, timezone, open_hour, close_hour) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, timezone, open_hour, close_hour`,
      [input.orgId, input.name.trim(), input.timezone, input.openHour, input.closeHour]
    );
    const row = res.rows[0];

    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
       VALUES ($1, $2, 'location.create', 'location', $3, $4)`,
      [input.orgId, actor.id, row.id, JSON.stringify({ name: row.name, timezone: row.timezone, openHour: row.open_hour, closeHour: row.close_hour })]
    );

    return {
      ok: true,
      location: {
        id: row.id,
        name: row.name,
        timezone: row.timezone,
        openHour: row.open_hour,
        closeHour: row.close_hour
      }
    };
  });
}

export async function updateLocation(
  pool: Pool,
  input: { orgId: string; actorUserId: string; locationId: string; name?: string; timezone?: string; openHour?: string; closeHour?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; location: { id: string; name: string; timezone: string; openHour: string; closeHour: string } } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.locationId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  
  const updates: any = {};
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 200) {
      return fail(400, 'validation_error', 'Invalid name', 'invalid_name');
    }
    updates.name = input.name.trim();
  }
  if (input.timezone !== undefined) {
    updates.timezone = input.timezone;
  }
  if (input.openHour !== undefined) {
    if (!isValidTimeFormat(input.openHour)) return fail(400, 'validation_error', 'Invalid hours', 'invalid_hours');
    updates.openHour = input.openHour;
  }
  if (input.closeHour !== undefined) {
    if (!isValidTimeFormat(input.closeHour)) return fail(400, 'validation_error', 'Invalid hours', 'invalid_hours');
    updates.closeHour = input.closeHour;
  }

  if (Object.keys(updates).length === 0) {
    return fail(400, 'validation_error', 'Nothing to update', 'nothing_to_update');
  }

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;
    if (actor.role !== 'org_admin') return fail(403, 'forbidden', 'Admin required', 'admin_required');

    const locRes = await client.query(`SELECT id, name, timezone, open_hour, close_hour FROM locations WHERE id = $1`, [input.locationId]);
    if (locRes.rows.length === 0) return fail(404, 'not_found', 'Location not found');
    const current = locRes.rows[0];

    if (updates.timezone) {
      const tzRes = await client.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [updates.timezone]);
      if (tzRes.rows.length === 0) return fail(400, 'validation_error', 'Invalid timezone', 'invalid_timezone');
    }

    const newOpen = updates.openHour || current.open_hour;
    const newClose = updates.closeHour || current.close_hour;
    if (newOpen >= newClose) return fail(400, 'validation_error', 'Invalid hours', 'invalid_hours');

    const setClauses: string[] = [];
    const params: any[] = [];
    let i = 1;
    const before: any = {};
    const after: any = {};

    if (updates.name !== undefined) {
      setClauses.push(`name = $${i++}`); params.push(updates.name);
      before.name = current.name; after.name = updates.name;
    }
    if (updates.timezone !== undefined) {
      setClauses.push(`timezone = $${i++}`); params.push(updates.timezone);
      before.timezone = current.timezone; after.timezone = updates.timezone;
    }
    if (updates.openHour !== undefined) {
      setClauses.push(`open_hour = $${i++}`); params.push(updates.openHour);
      before.openHour = current.open_hour; after.openHour = updates.openHour;
    }
    if (updates.closeHour !== undefined) {
      setClauses.push(`close_hour = $${i++}`); params.push(updates.closeHour);
      before.closeHour = current.close_hour; after.closeHour = updates.closeHour;
    }

    params.push(input.locationId);
    await client.query(`UPDATE locations SET ${setClauses.join(', ')} WHERE id = $${i}`, params);

    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
       VALUES ($1, $2, 'location.update', 'location', $3, $4)`,
      [input.orgId, actor.id, input.locationId, JSON.stringify({ before, after })]
    );

    const updatedRes = await client.query(`SELECT id, name, timezone, open_hour, close_hour FROM locations WHERE id = $1`, [input.locationId]);
    const row = updatedRes.rows[0];

    return {
      ok: true,
      location: {
        id: row.id,
        name: row.name,
        timezone: row.timezone,
        openHour: row.open_hour,
        closeHour: row.close_hour
      }
    };
  });
}

export async function createResource(
  pool: Pool,
  input: { orgId: string; actorUserId: string; locationId: string; type: string; name: string; capacity?: number; hourlyRateCents: number; dayRateCents: number; status?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; resource: any } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.locationId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  
  const validTypes = ['desk', 'dedicated_desk', 'meeting_room', 'phone_booth', 'parking'];
  if (!validTypes.includes(input.type)) return fail(400, 'validation_error', 'Invalid type', 'invalid_type');
  
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 200) {
    return fail(400, 'validation_error', 'Invalid name', 'invalid_name');
  }

  const capacity = input.capacity ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
    return fail(400, 'validation_error', 'Invalid capacity', 'invalid_capacity');
  }

  if (!Number.isInteger(input.hourlyRateCents) || input.hourlyRateCents < 0 || input.hourlyRateCents > 2000000000) {
    return fail(400, 'validation_error', 'Invalid rate', 'invalid_rate');
  }
  if (!Number.isInteger(input.dayRateCents) || input.dayRateCents < 0 || input.dayRateCents > 2000000000) {
    return fail(400, 'validation_error', 'Invalid rate', 'invalid_rate');
  }

  const status = input.status ?? 'active';
  const validStatuses = ['active', 'maintenance', 'retired'];
  if (!validStatuses.includes(status)) return fail(400, 'validation_error', 'Invalid status', 'invalid_status');

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;
    if (actor.role !== 'org_admin') return fail(403, 'forbidden', 'Admin required', 'admin_required');

    const locRes = await client.query(`SELECT id FROM locations WHERE id = $1`, [input.locationId]);
    if (locRes.rows.length === 0) return fail(404, 'not_found', 'Location not found');

    const qrToken = crypto.randomBytes(24).toString('base64url');

    const res = await client.query(
      `INSERT INTO resources (org_id, location_id, type, name, capacity, status, hourly_rate_cents, day_rate_cents, qr_token) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING id, location_id, type, name, capacity, status, hourly_rate_cents, day_rate_cents`,
      [input.orgId, input.locationId, input.type, input.name.trim(), capacity, status, input.hourlyRateCents, input.dayRateCents, qrToken]
    );
    const row = res.rows[0];

    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
       VALUES ($1, $2, 'resource.create', 'resource', $3, $4)`,
      [input.orgId, actor.id, row.id, JSON.stringify({ locationId: row.location_id, type: row.type, name: row.name })]
    );

    return {
      ok: true,
      resource: {
        id: row.id,
        locationId: row.location_id,
        type: row.type,
        name: row.name,
        capacity: row.capacity,
        status: row.status,
        hourlyRateCents: row.hourly_rate_cents,
        dayRateCents: row.day_rate_cents
      }
    };
  });
}

export async function updateResource(
  pool: Pool,
  input: { orgId: string; actorUserId: string; resourceId: string; name?: string; capacity?: number; hourlyRateCents?: number; dayRateCents?: number; status?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; resource: any; activeFutureBookings?: number } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.resourceId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  
  const updates: any = {};
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 200) {
      return fail(400, 'validation_error', 'Invalid name', 'invalid_name');
    }
    updates.name = input.name.trim();
  }
  if (input.capacity !== undefined) {
    if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 1000) {
      return fail(400, 'validation_error', 'Invalid capacity', 'invalid_capacity');
    }
    updates.capacity = input.capacity;
  }
  if (input.hourlyRateCents !== undefined) {
    if (!Number.isInteger(input.hourlyRateCents) || input.hourlyRateCents < 0 || input.hourlyRateCents > 2000000000) {
      return fail(400, 'validation_error', 'Invalid rate', 'invalid_rate');
    }
    updates.hourlyRateCents = input.hourlyRateCents;
  }
  if (input.dayRateCents !== undefined) {
    if (!Number.isInteger(input.dayRateCents) || input.dayRateCents < 0 || input.dayRateCents > 2000000000) {
      return fail(400, 'validation_error', 'Invalid rate', 'invalid_rate');
    }
    updates.dayRateCents = input.dayRateCents;
  }
  if (input.status !== undefined) {
    const validStatuses = ['active', 'maintenance', 'retired'];
    if (!validStatuses.includes(input.status)) return fail(400, 'validation_error', 'Invalid status', 'invalid_status');
    updates.status = input.status;
  }

  if (Object.keys(updates).length === 0) {
    return fail(400, 'validation_error', 'Nothing to update', 'nothing_to_update');
  }

  const now = opts?.now || new Date();

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;
    if (actor.role !== 'org_admin') return fail(403, 'forbidden', 'Admin required', 'admin_required');

    const resRes = await client.query(`SELECT id, name, capacity, status, hourly_rate_cents, day_rate_cents FROM resources WHERE id = $1`, [input.resourceId]);
    if (resRes.rows.length === 0) return fail(404, 'not_found', 'Resource not found');
    const current = resRes.rows[0];

    const newStatus = updates.status || current.status;
    let activeFutureBookings: number | undefined = undefined;

    if (newStatus !== 'active') {
      const countRes = await client.query(
        `SELECT count(*) FROM bookings 
         WHERE resource_id = $1 
           AND status IN ('confirmed', 'checked_in') 
           AND upper(period) > $2`,
        [input.resourceId, now.toISOString()]
      );
      activeFutureBookings = Number(countRes.rows[0].count);
    }

    const setClauses: string[] = [];
    const params: any[] = [];
    let i = 1;
    const before: any = {};
    const after: any = {};

    if (updates.name !== undefined) {
      setClauses.push(`name = $${i++}`); params.push(updates.name);
      before.name = current.name; after.name = updates.name;
    }
    if (updates.capacity !== undefined) {
      setClauses.push(`capacity = $${i++}`); params.push(updates.capacity);
      before.capacity = current.capacity; after.capacity = updates.capacity;
    }
    if (updates.hourlyRateCents !== undefined) {
      setClauses.push(`hourly_rate_cents = $${i++}`); params.push(updates.hourlyRateCents);
      before.hourlyRateCents = current.hourly_rate_cents; after.hourlyRateCents = updates.hourlyRateCents;
    }
    if (updates.dayRateCents !== undefined) {
      setClauses.push(`day_rate_cents = $${i++}`); params.push(updates.dayRateCents);
      before.dayRateCents = current.day_rate_cents; after.dayRateCents = updates.dayRateCents;
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${i++}`); params.push(updates.status);
      before.status = current.status; after.status = updates.status;
    }

    params.push(input.resourceId);
    await client.query(`UPDATE resources SET ${setClauses.join(', ')} WHERE id = $${i}`, params);

    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
       VALUES ($1, $2, 'resource.update', 'resource', $3, $4)`,
      [input.orgId, actor.id, input.resourceId, JSON.stringify({ before, after })]
    );

    const updatedRes = await client.query(`SELECT id, location_id, type, name, capacity, status, hourly_rate_cents, day_rate_cents FROM resources WHERE id = $1`, [input.resourceId]);
    const row = updatedRes.rows[0];

    const result: any = {
      ok: true,
      resource: {
        id: row.id,
        locationId: row.location_id,
        type: row.type,
        name: row.name,
        capacity: row.capacity,
        status: row.status,
        hourlyRateCents: row.hourly_rate_cents,
        dayRateCents: row.day_rate_cents
      }
    };
    if (activeFutureBookings !== undefined) {
      result.activeFutureBookings = activeFutureBookings;
    }
    return result;
  });
}

export async function createBlock(
  pool: Pool,
  input: { orgId: string; actorUserId: string; resourceId: string; start: string; end: string; reason?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; block: any } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.resourceId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  
  if (!isValidIso8601WithTz(input.start) || !isValidIso8601WithTz(input.end)) {
    return fail(400, 'validation_error', 'Invalid time', 'invalid_time');
  }
  const startDate = new Date(input.start);
  const endDate = new Date(input.end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return fail(400, 'validation_error', 'Invalid time', 'invalid_time');
  }
  if (startDate.getTime() >= endDate.getTime()) {
    return fail(400, 'validation_error', 'Invalid range', 'invalid_range');
  }
  if (startDate.getTime() % 900000 !== 0 || endDate.getTime() % 900000 !== 0) {
    return fail(400, 'validation_error', 'Not on slot boundary', 'not_on_slot_boundary');
  }
  
  const now = opts?.now || new Date();
  if (endDate.getTime() <= now.getTime()) {
    return fail(422, 'policy_violation', 'In the past', 'in_the_past');
  }

  let reason: string | null = null;
  if (input.reason !== undefined) {
    if (typeof input.reason !== 'string' || input.reason.trim().length < 1 || input.reason.trim().length > 500) {
      return fail(400, 'validation_error', 'Invalid reason', 'invalid_reason');
    }
    reason = input.reason.trim();
  }

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;
    if (!isManager(actor.role)) return fail(403, 'forbidden', 'Manager required', 'manager_required');

    const resRes = await client.query(`SELECT id FROM resources WHERE id = $1 FOR UPDATE`, [input.resourceId]);
    if (resRes.rows.length === 0) return fail(404, 'not_found', 'Resource not found');

    const overlapRes = await client.query(
      `SELECT 1 FROM bookings 
       WHERE resource_id = $1 
         AND status IN ('pending_payment', 'confirmed', 'checked_in') 
         AND period && tstzrange($2, $3, '[)')`,
      [input.resourceId, input.start, input.end]
    );
    if (overlapRes.rows.length > 0) {
      return fail(409, 'conflict', 'Cancel or move the bookings in that window first', 'overlaps_bookings');
    }

    try {
      const insertRes = await client.query(
        `INSERT INTO resource_blocks (org_id, resource_id, period, reason) 
         VALUES ($1, $2, tstzrange($3, $4, '[)'), $5) 
         RETURNING id, resource_id, lower(period) AS start, upper(period) AS "end", reason, created_at`,
        [input.orgId, input.resourceId, input.start, input.end, reason]
      );
      const row = insertRes.rows[0];

      await client.query(
        `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
         VALUES ($1, $2, 'block.create', 'block', $3, $4)`,
        [input.orgId, actor.id, row.id, JSON.stringify({ resourceId: row.resource_id, start: new Date(row.start).toISOString(), end: new Date(row.end).toISOString(), reason: row.reason })]
      );

      return {
        ok: true,
        block: {
          id: row.id,
          resourceId: row.resource_id,
          start: new Date(row.start).toISOString(),
          end: new Date(row.end).toISOString(),
          reason: row.reason,
          createdAt: new Date(row.created_at).toISOString()
        }
      };
    } catch (err: any) {
      if (err.code === '23P01') {
        return fail(409, 'conflict', 'Overlapping block', 'overlapping_block');
      }
      throw err;
    }
  });
}

export async function deleteBlock(
  pool: Pool,
  input: { orgId: string; actorUserId: string; blockId: string },
  opts?: { now?: Date }
): Promise<{ ok: true } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.blockId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;
    if (!isManager(actor.role)) return fail(403, 'forbidden', 'Manager required', 'manager_required');

    const blockRes = await client.query(
      `SELECT id, resource_id, lower(period) AS start, upper(period) AS "end" FROM resource_blocks WHERE id = $1`,
      [input.blockId]
    );
    if (blockRes.rows.length === 0) return fail(404, 'not_found', 'Block not found');
    const row = blockRes.rows[0];

    await client.query(
      `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
       VALUES ($1, $2, 'block.delete', 'block', $3, $4)`,
      [input.orgId, actor.id, input.blockId, JSON.stringify({ resourceId: row.resource_id, start: new Date(row.start).toISOString(), end: new Date(row.end).toISOString() })]
    );

    await client.query(`DELETE FROM resource_blocks WHERE id = $1`, [input.blockId]);

    return { ok: true };
  });
}

export async function listBlocks(
  pool: Pool,
  input: { orgId: string; actorUserId: string; resourceId: string },
  opts?: { now?: Date }
): Promise<{ ok: true; blocks: any[] } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.resourceId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  const now = opts?.now || new Date();

  return await withOrg(pool, input.orgId, async (client) => {
    const actor = await loadActor(client, input.actorUserId);
    if (!('id' in actor)) return actor;

    const resRes = await client.query(`SELECT id FROM resources WHERE id = $1`, [input.resourceId]);
    if (resRes.rows.length === 0) return fail(404, 'not_found', 'Resource not found');

    const blocksRes = await client.query(
      `SELECT id, resource_id, lower(period) AS start, upper(period) AS "end", reason, created_at 
       FROM resource_blocks 
       WHERE resource_id = $1 AND upper(period) > $2 
       ORDER BY lower(period), id`,
      [input.resourceId, now.toISOString()]
    );

    return {
      ok: true,
      blocks: blocksRes.rows.map((r: any) => ({
        id: r.id,
        resourceId: r.resource_id,
        start: new Date(r.start).toISOString(),
        end: new Date(r.end).toISOString(),
        reason: r.reason,
        createdAt: new Date(r.created_at).toISOString()
      }))
    };
  });
}