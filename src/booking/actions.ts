import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { isUuid, fail, loadActor, isManager, ceilTo15 } from '../common/result.js';

export async function markArrived(
  pool: Pool,
  input: { orgId: string; bookingId: string; actorUserId: string },
  opts?: { now?: Date }
): Promise<{ ok: true; booking: { id: string; status: 'checked_in'; checkinAt: string } } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.bookingId) || !isUuid(input.actorUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  const now = opts?.now || new Date();

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const lockRes = await client.query(
        `SELECT id, status, lower(period) as start_tz, upper(period) as end_tz FROM bookings WHERE id = $1 FOR UPDATE`,
        [input.bookingId]
      );
      if (lockRes.rows.length === 0) {
        return fail(404, 'not_found', 'Booking not found');
      }
      const booking = lockRes.rows[0];

      if (booking.status !== 'confirmed') {
        return fail(409, 'invalid_state', 'Booking is not confirmed', 'not_confirmed');
      }

      const start = new Date(booking.start_tz);
      const end = new Date(booking.end_tz);

      if (now.getTime() >= end.getTime()) {
        return fail(422, 'policy_violation', 'Booking has ended', 'booking_ended');
      }
      const windowStart = new Date(start.getTime() - 15 * 60 * 1000);
      if (now.getTime() < windowStart.getTime()) {
        return fail(422, 'policy_violation', 'Outside check-in window', 'outside_checkin_window');
      }

      await client.query(
        `UPDATE bookings SET status = 'checked_in', checkin_at = $1, updated_at = now() WHERE id = $2`,
        [now.toISOString(), input.bookingId]
      );

      await client.query(`
        INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [input.orgId, actor.id, 'booking.arrived', 'booking', input.bookingId, JSON.stringify({})]);

      return {
        ok: true,
        booking: {
          id: input.bookingId,
          status: 'checked_in',
          checkinAt: now.toISOString()
        }
      };
    });
  } catch (err: any) {
    throw err;
  }
}

export async function cancelBooking(
  pool: Pool,
  input: { orgId: string; bookingId: string; actorUserId: string; reason?: string; refundCents?: number },
  opts?: { now?: Date }
): Promise<{ ok: true; booking: { id: string; status: 'cancelled' }; refund: { paymentId: string; amountCents: number } | null } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.bookingId) || !isUuid(input.actorUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  if (input.refundCents !== undefined) {
    if (!Number.isInteger(input.refundCents) || input.refundCents <= 0 || input.refundCents > 2000000000) {
      return fail(400, 'validation_error', 'Invalid amount', 'invalid_amount');
    }
  }
  if (input.reason !== undefined) {
    const trimmed = String(input.reason).trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      return fail(400, 'validation_error', 'Invalid reason', 'invalid_reason');
    }
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const lockRes = await client.query(
        `SELECT id, status, price_cents FROM bookings WHERE id = $1 FOR UPDATE`,
        [input.bookingId]
      );
      if (lockRes.rows.length === 0) {
        return fail(404, 'not_found', 'Booking not found');
      }
      const booking = lockRes.rows[0];

      if (booking.status === 'checked_in') {
        return fail(409, 'invalid_state', 'Use release for checked-in bookings', 'use_release');
      }
      if (booking.status !== 'confirmed') {
        return fail(409, 'invalid_state', 'Booking is not confirmed', 'not_confirmed');
      }

      const sumRes = await client.query(
        `SELECT COALESCE(SUM(amount_cents), 0) as net FROM payments WHERE booking_id = $1`,
        [input.bookingId]
      );
      const netPaid = Number(sumRes.rows[0].net);

      if (netPaid > 0 || input.refundCents !== undefined) {
        if (!isManager(actor.role)) {
          return fail(403, 'forbidden', 'Manager required', 'manager_required');
        }
      }

      if (input.refundCents !== undefined && input.refundCents > netPaid) {
        return fail(422, 'policy_violation', 'Refund exceeds paid', 'refund_exceeds_paid');
      }

      const reasonStr = input.reason ? String(input.reason).trim() : null;

      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancellation_reason = $1, updated_at = now() WHERE id = $2`,
        [reasonStr, input.bookingId]
      );

      await client.query(`
        INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [input.orgId, actor.id, 'booking.cancel', 'booking', input.bookingId, JSON.stringify({ reason: reasonStr, refundCents: input.refundCents || null })]);

      let refundObj = null;
      if (input.refundCents !== undefined) {
        const payRes = await client.query(
          `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) 
           VALUES ($1, $2, $3, 'refund', $4) RETURNING id, amount_cents, kind, created_at`,
          [input.orgId, input.bookingId, -input.refundCents, actor.id]
        );
        refundObj = {
          paymentId: payRes.rows[0].id,
          amountCents: payRes.rows[0].amount_cents
        };
        await client.query(`
          INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [input.orgId, actor.id, 'payment.refund', 'payment', refundObj.paymentId, JSON.stringify({ amountCents: -input.refundCents })]);
      }

      return {
        ok: true,
        booking: { id: input.bookingId, status: 'cancelled' },
        refund: refundObj
      };
    });
  } catch (err: any) {
    throw err;
  }
}

export async function releaseBooking(
  pool: Pool,
  input: { orgId: string; bookingId: string; actorUserId: string },
  opts?: { now?: Date }
): Promise<{ ok: true; booking: { id: string; status: 'completed' | 'cancelled'; end: string; releasedBeforeStart: boolean } } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.bookingId) || !isUuid(input.actorUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  const now = opts?.now || new Date();
  const roundedEnd = ceilTo15(now);

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const lockRes = await client.query(
        `SELECT id, status, lower(period) as start_tz, upper(period) as end_tz FROM bookings WHERE id = $1 FOR UPDATE`,
        [input.bookingId]
      );
      if (lockRes.rows.length === 0) {
        return fail(404, 'not_found', 'Booking not found');
      }
      const booking = lockRes.rows[0];

      if (booking.status !== 'checked_in') {
        return fail(409, 'invalid_state', 'Booking is not checked in', 'not_checked_in');
      }

      const start = new Date(booking.start_tz);
      const end = new Date(booking.end_tz);

      let outcome: 'completed' | 'cancelled' = 'completed';
      let releasedBeforeStart = false;
      let newEnd = end;

      if (roundedEnd.getTime() <= start.getTime()) {
        outcome = 'cancelled';
        releasedBeforeStart = true;
        await client.query(
          `UPDATE bookings SET status = 'cancelled', cancellation_reason = 'released_before_start', updated_at = now() WHERE id = $1`,
          [input.bookingId]
        );
      } else {
        const leastEnd = end.getTime() < roundedEnd.getTime() ? end : roundedEnd;
        newEnd = leastEnd;
        await client.query(
          `UPDATE bookings SET status = 'completed', period = tstzrange(lower(period), $1, '[)'), updated_at = now() WHERE id = $2`,
          [newEnd.toISOString(), input.bookingId]
        );
      }

      await client.query(`
        INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [input.orgId, actor.id, 'booking.release', 'booking', input.bookingId, JSON.stringify({ outcome, end: newEnd.toISOString() })]);

      return {
        ok: true,
        booking: {
          id: input.bookingId,
          status: outcome,
          end: newEnd.toISOString(),
          releasedBeforeStart
        }
      };
    });
  } catch (err: any) {
    throw err;
  }
}