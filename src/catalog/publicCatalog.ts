// src/catalog/publicCatalog.ts
// Unauthenticated read-only catalogue for the customer portal.
// Resolves the organisation from its public slug, then reads only active
// locations/resources and the busy windows customers need to pick a free slot.
import { Pool } from 'pg';
import { withOrg, resolveOrgId } from '../db/withOrg.js';
import { fail, Failure, isUuid } from '../common/result.js';

export interface PublicOrg {
  id: string;
  name: string;
  slug: string;
}

export interface PublicLocation {
  id: string;
  name: string;
  timezone: string;
  openHour: string;
  closeHour: string;
}

export interface PublicResource {
  id: string;
  locationId: string;
  type: string;
  name: string;
  capacity: number;
  hourlyRateCents: number;
  dayRateCents: number;
}

export interface PublicSlot {
  start: string;
  end: string;
  status: string;
}

export interface PublicBlock {
  start: string;
  end: string;
  reason: string | null;
}

export interface PublicAvailabilityResource {
  id: string;
  intervals: PublicSlot[];
  blocks: PublicBlock[];
}

export interface PublicAvailability {
  date: string;
  locationId: string;
  timezone: string;
  resources: PublicAvailabilityResource[];
}

async function resolveOrg(pool: Pool, slug: string): Promise<{ ok: true; orgId: string } | Failure> {
  const clean = (slug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,60}$/.test(clean)) {
    return fail(404, 'not_found', 'Organisation not found', 'unknown_org');
  }
  const orgId = await resolveOrgId(pool, clean);
  if (!orgId) {
    return fail(404, 'not_found', 'Organisation not found', 'unknown_org');
  }
  return { ok: true, orgId };
}

export async function publicOrg(pool: Pool, slug: string): Promise<{ ok: true; org: PublicOrg } | Failure> {
  const resolved = await resolveOrg(pool, slug);
  if (!resolved.ok) return resolved;
  return withOrg(pool, resolved.orgId, async (client) => {
    const res = await client.query(`SELECT id, name, slug FROM organizations WHERE id = $1`, [resolved.orgId]);
    if (res.rows.length === 0) return fail(404, 'not_found', 'Organisation not found', 'unknown_org');
    const row = res.rows[0];
    return {
      ok: true,
      org: { id: row.id, name: row.name, slug: row.slug }
    };
  });
}

export async function publicLocations(pool: Pool, slug: string): Promise<{ ok: true; locations: PublicLocation[] } | Failure> {
  const resolved = await resolveOrg(pool, slug);
  if (!resolved.ok) return resolved;
  return withOrg(pool, resolved.orgId, async (client) => {
    const res = await client.query(
      `SELECT id, name, timezone, open_hour, close_hour
       FROM locations
       ORDER BY name, id`
    );
    return {
      ok: true,
      locations: res.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        timezone: r.timezone,
        openHour: typeof r.open_hour === 'string' ? r.open_hour.slice(0, 5) : r.open_hour,
        closeHour: typeof r.close_hour === 'string' ? r.close_hour.slice(0, 5) : r.close_hour
      }))
    };
  });
}

export async function publicResources(
  pool: Pool,
  slug: string,
  locationId?: string
): Promise<{ ok: true; resources: PublicResource[] } | Failure> {
  const resolved = await resolveOrg(pool, slug);
  if (!resolved.ok) return resolved;

  if (locationId !== undefined && !isUuid(locationId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  return withOrg(pool, resolved.orgId, async (client) => {
    if (locationId !== undefined) {
      const locRes = await client.query(`SELECT id FROM locations WHERE id = $1`, [locationId]);
      if (locRes.rows.length === 0) return fail(404, 'not_found', 'Location not found', 'location_not_found');
    }

    const params: any[] = [];
    let where = `status = 'active'`;
    if (locationId !== undefined) {
      params.push(locationId);
      where += ` AND location_id = $${params.length}`;
    }
    const res = await client.query(
      `SELECT id, location_id, type, name, capacity, hourly_rate_cents, day_rate_cents
       FROM resources
       WHERE ${where}
       ORDER BY type, name, id`,
      params
    );

    return {
      ok: true,
      resources: res.rows.map((r: any) => ({
        id: r.id,
        locationId: r.location_id,
        type: r.type,
        name: r.name,
        capacity: Number(r.capacity),
        hourlyRateCents: Number(r.hourly_rate_cents),
        dayRateCents: Number(r.day_rate_cents)
      }))
    };
  });
}

export async function publicAvailability(
  pool: Pool,
  slug: string,
  input: { locationId: string; date: string }
): Promise<{ ok: true; availability: PublicAvailability } | Failure> {
  const resolved = await resolveOrg(pool, slug);
  if (!resolved.ok) return resolved;

  if (!isUuid(input.locationId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return fail(400, 'validation_error', 'Invalid date', 'invalid_date');
  }
  const d = new Date(`${input.date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.date) {
    return fail(400, 'validation_error', 'Invalid date', 'invalid_date');
  }

  return withOrg(pool, resolved.orgId, async (client) => {
    const locRes = await client.query(`SELECT id, timezone, open_hour, close_hour FROM locations WHERE id = $1`, [input.locationId]);
    if (locRes.rows.length === 0) return fail(404, 'not_found', 'Location not found', 'location_not_found');
    const loc = locRes.rows[0];

    const resourcesRes = await client.query(
      `SELECT id FROM resources
       WHERE location_id = $1 AND status = 'active'
       ORDER BY type, name, id`,
      [input.locationId]
    );
    const resourceIds = resourcesRes.rows.map((r: any) => r.id);

    const availability: PublicAvailability = {
      date: input.date,
      locationId: input.locationId,
      timezone: loc.timezone,
      resources: resourceIds.map((id: string) => ({ id, intervals: [], blocks: [] }))
    };

    if (resourceIds.length === 0) return { ok: true, availability };

    const bookingsRes = await client.query(
      `WITH day_interval AS (
         SELECT ($1::date)::timestamp AT TIME ZONE $2 AS start_tz,
                (($1::date + 1))::timestamp AT TIME ZONE $2 AS end_tz
       )
       SELECT b.resource_id, lower(b.period) AS start, upper(b.period) AS "end", b.status
       FROM bookings b
       CROSS JOIN day_interval di
       WHERE b.resource_id = ANY($3::uuid[])
         AND b.status IN ('pending_payment', 'confirmed', 'checked_in')
         AND b.period && tstzrange(di.start_tz, di.end_tz, '[)')
       ORDER BY b.resource_id, lower(b.period)`,
      [input.date, loc.timezone, resourceIds]
    );

    const blocksRes = await client.query(
      `WITH day_interval AS (
         SELECT ($1::date)::timestamp AT TIME ZONE $2 AS start_tz,
                (($1::date + 1))::timestamp AT TIME ZONE $2 AS end_tz
       )
       SELECT rb.resource_id, lower(rb.period) AS start, upper(rb.period) AS "end", rb.reason
       FROM resource_blocks rb
       CROSS JOIN day_interval di
       WHERE rb.resource_id = ANY($3::uuid[])
         AND rb.period && tstzrange(di.start_tz, di.end_tz, '[)')
       ORDER BY rb.resource_id, lower(rb.period)`,
      [input.date, loc.timezone, resourceIds]
    );

    for (const row of bookingsRes.rows) {
      const entry = availability.resources.find((item) => item.id === row.resource_id);
      if (entry) {
        entry.intervals.push({
          start: new Date(row.start).toISOString(),
          end: new Date(row.end).toISOString(),
          status: row.status
        });
      }
    }
    for (const row of blocksRes.rows) {
      const entry = availability.resources.find((item) => item.id === row.resource_id);
      if (entry) {
        entry.blocks.push({
          start: new Date(row.start).toISOString(),
          end: new Date(row.end).toISOString(),
          reason: row.reason
        });
      }
    }

    return { ok: true, availability };
  });
}
