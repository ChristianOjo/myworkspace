// src/booking/createBooking.ts
import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';

export interface CreateBookingInput {
  orgId: string;
  userId: string;
  resourceId: string;
  start?: string | Date;
  end?: string | Date;
  kind?: 'hourly' | 'day';
  date?: string;
  customerName?: string;
  customerPhone?: string;
  arrivedNow?: boolean;
}

export interface Booking {
  id: string;
  orgId: string;
  userId: string;
  resourceId: string;
  start: string;
  end: string;
  status: 'confirmed' | 'checked_in';
  createdAt: string;
  customerName: string | null;
  customerPhone: string | null;
  priceCents: number;
  pricing: 'hourly' | 'day';
  checkinAt: string | null;
}

export type CreateBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; http: 400 | 404 | 409 | 422;
      code: 'validation_error' | 'not_found' | 'slot_conflict' | 'policy_violation';
      reason?: string; message: string };

export async function createBooking(
  pool: Pool, input: CreateBookingInput, opts?: { now?: Date }
): Promise<CreateBookingResult> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(input.orgId) || !uuidRegex.test(input.userId) || !uuidRegex.test(input.resourceId)) {
    return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_id', message: 'Invalid ID' };
  }

  const kind = input.kind || 'hourly';
  if (kind !== 'hourly' && kind !== 'day') {
    return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_kind', message: 'Invalid kind' };
  }

  const parseTime = (val: string | Date): Date | null => {
    if (val instanceof Date) {
      return isNaN(val.getTime()) ? null : val;
    }
    if (typeof val === 'string') {
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
      if (!isoRegex.test(val)) return null;
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  };

  let startDate: Date | null = null;
  let endDate: Date | null = null;
  let bookingDateStr: string | null = null;

  if (kind === 'hourly') {
    if (!input.start || !input.end) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_time', message: 'Invalid time' };
    }
    startDate = parseTime(input.start);
    endDate = parseTime(input.end);
    if (!startDate || !endDate) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_time', message: 'Invalid time' };
    }
    if (startDate.getTime() >= endDate.getTime()) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_range', message: 'Invalid range' };
    }
    if (startDate.getTime() % 900000 !== 0 || endDate.getTime() % 900000 !== 0) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'not_on_slot_boundary', message: 'Not on slot boundary' };
    }
  } else {
    if (!input.date) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_time', message: 'Invalid time' };
    }
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(input.date)) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_time', message: 'Invalid time' };
    }
    const d = new Date(input.date + 'T00:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.date) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_time', message: 'Invalid time' };
    }
    bookingDateStr = input.date;
  }

  let cName: string | null = null;
  if (input.customerName !== undefined) {
    const trimmed = String(input.customerName).trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_customer', message: 'Invalid customer' };
    }
    cName = trimmed;
  }

  let cPhone: string | null = null;
  if (input.customerPhone !== undefined) {
    const trimmed = String(input.customerPhone).trim();
    if (trimmed.length < 1 || trimmed.length > 50) {
      return { ok: false, http: 400, code: 'validation_error', reason: 'invalid_customer', message: 'Invalid customer' };
    }
    cPhone = trimmed;
  }

  const now = opts?.now || new Date();
  if (kind === 'hourly' && startDate && startDate.getTime() < (now.getTime() - (now.getTime() % 900000))) {
    return { ok: false, http: 422, code: 'policy_violation', reason: 'in_the_past', message: 'In the past' };
  }

  if (input.arrivedNow && kind === 'hourly' && startDate && startDate.getTime() > now.getTime()) {
    return { ok: false, http: 422, code: 'policy_violation', reason: 'arrived_before_start', message: 'Arrived before start' };
  }

  try {
    const result = await withOrg(pool, input.orgId, async (client) => {
      // Lock the resource row in share mode to prevent concurrent block creation from succeeding on the same slot
      const resRes = await client.query(`
        SELECT r.id, r.status, r.hourly_rate_cents, r.day_rate_cents, l.timezone, l.open_hour, l.close_hour
        FROM resources r
        JOIN locations l ON l.id = r.location_id
        WHERE r.id = $1
        FOR SHARE OF r
      `, [input.resourceId]);

      if (resRes.rows.length === 0) {
        return { ok: false, http: 404, code: 'not_found', message: 'Resource not found' };
      }

      const resource = resRes.rows[0];

      const userRes = await client.query(`
        SELECT id, email, full_name, role, deactivated_at FROM users WHERE id = $1
      `, [input.userId]);

      if (userRes.rows.length === 0) {
        return { ok: false, http: 404, code: 'not_found', message: 'User not found' };
      }

      const user = userRes.rows[0];

      if (user.deactivated_at !== null) {
        return { ok: false, http: 422, code: 'policy_violation', reason: 'user_inactive', message: 'User inactive' };
      }

      if (resource.status !== 'active') {
        return { ok: false, http: 422, code: 'policy_violation', reason: 'resource_unavailable', message: 'Resource unavailable' };
      }

      let priceCents = 0;
      let startIso: string | null = null;
      let endIso: string | null = null;

      if (kind === 'hourly') {
        const hoursCheck = await client.query(`
          SELECT 
            (($1::timestamptz AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date) AS same_date,
            (($1::timestamptz AT TIME ZONE $2)::time >= $4::time) AS after_open,
            (($3::timestamptz AT TIME ZONE $2)::time <= $5::time) AS before_close
        `, [input.start, resource.timezone, input.end, resource.open_hour, resource.close_hour]);

        const hours = hoursCheck.rows[0];
        if (!hours.same_date || !hours.after_open || !hours.before_close) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'outside_hours', message: 'Outside hours' };
        }

        const blockCheck = await client.query(`
          SELECT 1 FROM resource_blocks
          WHERE resource_id = $1 AND period && tstzrange($2, $3, '[)')
        `, [input.resourceId, input.start, input.end]);

        if (blockCheck.rows.length > 0) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'maintenance_block', message: 'Maintenance block' };
        }

        const minutes = (endDate!.getTime() - startDate!.getTime()) / 60000;
        priceCents = Math.round(resource.hourly_rate_cents * minutes / 60);
        startIso = startDate!.toISOString();
        endIso = endDate!.toISOString();
      } else {
        if (resource.day_rate_cents === 0) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'day_booking_not_offered', message: 'Day booking not offered' };
        }

        const dayCheck = await client.query(`
          SELECT 
            (($1::date + $2::time) AT TIME ZONE $3) AS start_tz,
            (($1::date + $4::time) AT TIME ZONE $3) AS end_tz
        `, [bookingDateStr, resource.open_hour, resource.timezone, resource.close_hour]);

        const dayRow = dayCheck.rows[0];
        const dayStart = new Date(dayRow.start_tz);
        const dayEnd = new Date(dayRow.end_tz);

        if (dayEnd.getTime() <= dayStart.getTime()) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'day_booking_not_offered', message: 'Day booking not offered' };
        }

        if (dayEnd.getTime() <= now.getTime()) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'in_the_past', message: 'In the past' };
        }

        if (input.arrivedNow && dayStart.getTime() > now.getTime()) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'arrived_before_start', message: 'Arrived before start' };
        }

        const blockCheck = await client.query(`
          SELECT 1 FROM resource_blocks
          WHERE resource_id = $1 AND period && tstzrange($2, $3, '[)')
        `, [input.resourceId, dayStart.toISOString(), dayEnd.toISOString()]);

        if (blockCheck.rows.length > 0) {
          return { ok: false, http: 422, code: 'policy_violation', reason: 'maintenance_block', message: 'Maintenance block' };
        }

        priceCents = resource.day_rate_cents;
        startIso = dayStart.toISOString();
        endIso = dayEnd.toISOString();
      }

      const status = input.arrivedNow ? 'checked_in' : 'confirmed';
      const checkinAt = input.arrivedNow ? now.toISOString() : null;

      const insertRes = await client.query(`
        INSERT INTO bookings (org_id, user_id, resource_id, period, status, customer_name, customer_phone, price_cents, pricing_type, checkin_at)
        VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6, $7, $8, $9, $10, $11)
        RETURNING id, org_id, user_id, resource_id, lower(period) AS start, upper(period) AS "end", status, created_at, customer_name, customer_phone, price_cents, pricing_type, checkin_at
      `, [input.orgId, input.userId, input.resourceId, startIso, endIso, status, cName, cPhone, priceCents, kind, checkinAt]);

      const row = insertRes.rows[0];

      await client.query(
        `INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff) 
         VALUES ($1, $2, 'booking.create', 'booking', $3, $4)`,
        [input.orgId, input.userId, row.id, JSON.stringify({ 
          resourceId: row.resource_id, 
          start: new Date(row.start).toISOString(), 
          end: new Date(row.end).toISOString(), 
          priceCents: row.price_cents, 
          pricing: row.pricing_type, 
          customerName: row.customer_name,
          arrivedNow: !!input.arrivedNow 
        })]
      );

      return {
        ok: true,
        booking: {
          id: row.id,
          orgId: row.org_id,
          userId: row.user_id,
          resourceId: row.resource_id,
          start: new Date(row.start).toISOString(),
          end: new Date(row.end).toISOString(),
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          priceCents: row.price_cents,
          pricing: row.pricing_type,
          checkinAt: row.checkin_at ? new Date(row.checkin_at).toISOString() : null
        }
      };
    });

    return result;
  } catch (err: any) {
    // Known limitation: a maintenance block created at the same instant as a booking is not protected by a constraint, because the two live in different tables.
    if (err.code === '23P01' || err.code === '40P01') {
      return { ok: false, http: 409, code: 'slot_conflict', reason: 'slot_taken', message: 'Slot just taken' };
    }
    throw err;
  }
}