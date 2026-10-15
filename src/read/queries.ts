import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { loadActor, fail, Failure, isUuid } from '../common/result.js';

export async function listLocations(
  pool: Pool,
  input: { orgId: string; actorUserId: string }
): Promise<{ ok: true; locations: Array<{ id: string; name: string; timezone: string; openHour: string; closeHour: string }> } | Failure> {
  if (!isUuid(input.actorUserId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const res = await client.query(`
        SELECT id, name, timezone, open_hour, close_hour 
        FROM locations 
        ORDER BY name, id
      `);
      return {
        ok: true,
        locations: res.rows.map((r: any) => ({
          id: r.id,
          name: r.name,
          timezone: r.timezone,
          openHour: r.open_hour,
          closeHour: r.close_hour
        }))
      };
    });
  } catch (err) {
    throw err;
  }
}

export async function listResources(
  pool: Pool,
  input: { orgId: string; actorUserId: string; locationId: string }
): Promise<{ ok: true; resources: Array<{ id: string; locationId: string; type: string; name: string; capacity: number; status: string; hourlyRateCents: number; dayRateCents: number }> } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.locationId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const locRes = await client.query(`SELECT id FROM locations WHERE id = $1`, [input.locationId]);
      if (locRes.rows.length === 0) {
        return fail(404, 'not_found', 'Location not found');
      }

      const res = await client.query(`
        SELECT id, location_id, type, name, capacity, status, hourly_rate_cents, day_rate_cents
        FROM resources
        WHERE location_id = $1 AND status != 'retired'
        ORDER BY type, name, id
      `, [input.locationId]);

      return {
        ok: true,
        resources: res.rows.map((r: any) => ({
          id: r.id,
          locationId: r.location_id,
          type: r.type,
          name: r.name,
          capacity: r.capacity,
          status: r.status,
          hourlyRateCents: r.hourly_rate_cents,
          dayRateCents: r.day_rate_cents
        }))
      };
    });
  } catch (err) {
    throw err;
  }
}

export async function listDayBookings(
  pool: Pool,
  input: { orgId: string; actorUserId: string; locationId: string; date: string; includeCancelled?: boolean }
): Promise<{ ok: true; date: string; locationId: string; timezone: string; bookings: any[] } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.locationId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(input.date)) return fail(400, 'validation_error', 'Invalid date', 'invalid_date');
  const d = new Date(input.date + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.date) {
    return fail(400, 'validation_error', 'Invalid date', 'invalid_date');
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const locRes = await client.query(`SELECT id, timezone FROM locations WHERE id = $1`, [input.locationId]);
      if (locRes.rows.length === 0) {
        return fail(404, 'not_found', 'Location not found');
      }
      const timezone = locRes.rows[0].timezone;

      const query = `
        WITH day_interval AS (
          SELECT 
            ($1::date)::timestamp AT TIME ZONE $2 AS start_tz,
            (($1::date + 1))::timestamp AT TIME ZONE $2 AS end_tz
        ),
        booking_data AS (
          SELECT 
            b.id,
            b.resource_id,
            r.name AS resource_name,
            lower(b.period) AS start,
            upper(b.period) AS "end",
            b.status,
            b.customer_name,
            b.customer_phone,
            b.price_cents,
            b.pricing_type,
            b.checkin_at,
            u.full_name AS created_by_name,
            COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE 0 END), 0) AS paid_cents,
            COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN ABS(p.amount_cents) ELSE 0 END), 0) AS refunded_cents
          FROM bookings b
          JOIN resources r ON b.resource_id = r.id
          JOIN users u ON b.user_id = u.id
          LEFT JOIN payments p ON b.id = p.booking_id
          CROSS JOIN day_interval di
          WHERE r.location_id = $3
            AND b.period && tstzrange(di.start_tz, di.end_tz, '[)')
          GROUP BY b.id, r.name, u.full_name
        )
        SELECT * FROM booking_data
        WHERE $4 = true OR status NOT IN ('cancelled', 'expired', 'draft')
        ORDER BY resource_name, resource_id, start
      `;

      const res = await client.query(query, [input.date, timezone, input.locationId, input.includeCancelled === true]);

      const bookings = res.rows.map((row: any) => {
        const priceCents = Number(row.price_cents);
        const paidCents = Number(row.paid_cents);
        const refundedCents = Number(row.refunded_cents);
        const netPaidCents = paidCents - refundedCents;
        
        let paymentStatus: string;
        if (['cancelled', 'no_show', 'expired'].includes(row.status)) {
          paymentStatus = 'void';
        } else if (priceCents - netPaidCents <= 0) {
          paymentStatus = 'paid';
        } else if (netPaidCents > 0) {
          paymentStatus = 'partial';
        } else {
          paymentStatus = 'unpaid';
        }

        return {
          id: row.id,
          resourceId: row.resource_id,
          resourceName: row.resource_name,
          start: new Date(row.start).toISOString(),
          end: new Date(row.end).toISOString(),
          status: row.status,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          priceCents,
          pricing: row.pricing_type,
          netPaidCents,
          paymentStatus,
          checkinAt: row.checkin_at ? new Date(row.checkin_at).toISOString() : null,
          createdByName: row.created_by_name
        };
      });

      return {
        ok: true,
        date: input.date,
        locationId: input.locationId,
        timezone,
        bookings
      };
    });
  } catch (err) {
    throw err;
  }
}

export async function getBookingDetail(
  pool: Pool,
  input: { orgId: string; actorUserId: string; bookingId: string }
): Promise<{ ok: true; booking: any; balance: any; payments: any[] } | Failure> {
  if (!isUuid(input.actorUserId) || !isUuid(input.bookingId)) return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const bookingRes = await client.query(`
        SELECT 
          b.id, b.resource_id, r.name AS resource_name, r.location_id,
          lower(b.period) AS start, upper(b.period) AS "end",
          b.status, b.customer_name, b.customer_phone, b.price_cents, b.pricing_type,
          b.checkin_at, b.cancellation_reason, b.created_at,
          u.full_name AS created_by_name
        FROM bookings b
        JOIN resources r ON b.resource_id = r.id
        JOIN users u ON b.user_id = u.id
        WHERE b.id = $1
      `, [input.bookingId]);

      if (bookingRes.rows.length === 0) {
        return fail(404, 'not_found', 'Booking not found');
      }

      const row = bookingRes.rows[0];
      const priceCents = Number(row.price_cents);

      const paymentRes = await client.query(`
        SELECT 
          p.id, p.kind, p.amount_cents, p.note, p.created_at,
          u.full_name AS received_by_name
        FROM payments p
        JOIN users u ON p.received_by = u.id
        WHERE p.booking_id = $1
        ORDER BY p.created_at, p.id
      `, [input.bookingId]);

      let paidCents = 0;
      let refundedCents = 0;
      const payments = paymentRes.rows.map((p: any) => {
        const amount = Number(p.amount_cents);
        if (p.kind === 'payment') paidCents += amount;
        else if (p.kind === 'refund') refundedCents += Math.abs(amount);
        
        return {
          id: p.id,
          kind: p.kind,
          amountCents: amount,
          receivedByName: p.received_by_name,
          note: p.note,
          createdAt: new Date(p.created_at).toISOString()
        };
      });

      const netPaidCents = paidCents - refundedCents;
      let paymentStatus: string;
      let dueCents = 0;

      if (['cancelled', 'no_show', 'expired'].includes(row.status)) {
        paymentStatus = 'void';
        dueCents = 0;
      } else {
        dueCents = Math.max(priceCents - netPaidCents, 0);
        if (dueCents === 0) paymentStatus = 'paid';
        else if (netPaidCents > 0) paymentStatus = 'partial';
        else paymentStatus = 'unpaid';
      }

      return {
        ok: true,
        booking: {
          id: row.id,
          resourceId: row.resource_id,
          resourceName: row.resource_name,
          locationId: row.location_id,
          start: new Date(row.start).toISOString(),
          end: new Date(row.end).toISOString(),
          status: row.status,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          priceCents,
          pricing: row.pricing_type,
          checkinAt: row.checkin_at ? new Date(row.checkin_at).toISOString() : null,
          cancellationReason: row.cancellation_reason,
          createdAt: new Date(row.created_at).toISOString(),
          createdByName: row.created_by_name
        },
        balance: {
          priceCents,
          paidCents,
          refundedCents,
          netPaidCents,
          dueCents,
          paymentStatus
        },
        payments
      };
    });
  } catch (err) {
    throw err;
  }
}