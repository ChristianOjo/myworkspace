import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { isUuid, fail, loadActor, isManager } from '../common/result.js';

export type Balance = {
  priceCents: number;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  dueCents: number;
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'void';
};

async function getBalance(client: any, bookingId: string): Promise<Balance> {
  const res = await client.query(
    `SELECT price_cents, status FROM bookings WHERE id = $1`,
    [bookingId]
  );
  const priceCents = Number(res.rows[0].price_cents);
  const status = res.rows[0].status;

  const sumRes = await client.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount_cents ELSE 0 END), 0) as paid,
       COALESCE(SUM(CASE WHEN kind = 'refund' THEN ABS(amount_cents) ELSE 0 END), 0) as refunded
     FROM payments WHERE booking_id = $1`,
    [bookingId]
  );
  const paidCents = Number(sumRes.rows[0].paid);
  const refundedCents = Number(sumRes.rows[0].refunded);
  const netPaidCents = paidCents - refundedCents;

  let dueCents = 0;
  let paymentStatus: Balance['paymentStatus'] = 'unpaid';

  if (status === 'cancelled' || status === 'no_show' || status === 'expired') {
    paymentStatus = 'void';
    dueCents = 0;
  } else {
    dueCents = Math.max(priceCents - netPaidCents, 0);
    if (dueCents === 0) {
      paymentStatus = 'paid';
    } else if (netPaidCents > 0) {
      paymentStatus = 'partial';
    } else {
      paymentStatus = 'unpaid';
    }
  }

  return { priceCents, paidCents, refundedCents, netPaidCents, dueCents, paymentStatus };
}

export async function getBookingBalance(
  pool: Pool,
  input: { orgId: string; bookingId: string }
): Promise<{ ok: true; balance: Balance } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.bookingId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const res = await client.query(`SELECT id FROM bookings WHERE id = $1`, [input.bookingId]);
      if (res.rows.length === 0) {
        return fail(404, 'not_found', 'Booking not found');
      }
      const balance = await getBalance(client, input.bookingId);
      return { ok: true, balance };
    });
  } catch (err: any) {
    throw err;
  }
}

export async function recordPayment(
  pool: Pool,
  input: { orgId: string; bookingId: string; actorUserId: string; amountCents: number; note?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; payment: { id: string; amountCents: number; kind: 'payment'; createdAt: string }; balance: Balance } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.bookingId) || !isUuid(input.actorUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 2000000000) {
    return fail(400, 'validation_error', 'Invalid amount', 'invalid_amount');
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.length > 500) {
      return fail(400, 'validation_error', 'Invalid note', 'invalid_note');
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

      if (booking.status !== 'confirmed' && booking.status !== 'checked_in' && booking.status !== 'completed') {
        return fail(422, 'policy_violation', 'Booking not payable', 'booking_not_payable');
      }

      const balance = await getBalance(client, input.bookingId);
      if (balance.netPaidCents + input.amountCents > booking.price_cents) {
        return fail(422, 'policy_violation', 'Overpayment', 'overpayment');
      }

      const payRes = await client.query(
        `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by, note) 
         VALUES ($1, $2, $3, 'payment', $4, $5) RETURNING id, amount_cents, kind, created_at`,
        [input.orgId, input.bookingId, input.amountCents, actor.id, input.note || null]
      );

      await client.query(`
        INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [input.orgId, actor.id, 'payment.record', 'payment', payRes.rows[0].id, JSON.stringify({ amountCents: input.amountCents })]);

      const newBalance = await getBalance(client, input.bookingId);

      return {
        ok: true,
        payment: {
          id: payRes.rows[0].id,
          amountCents: payRes.rows[0].amount_cents,
          kind: payRes.rows[0].kind,
          createdAt: new Date(payRes.rows[0].created_at).toISOString()
        },
        balance: newBalance
      };
    });
  } catch (err: any) {
    throw err;
  }
}

export async function recordRefund(
  pool: Pool,
  input: { orgId: string; bookingId: string; actorUserId: string; amountCents: number; note?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; payment: { id: string; amountCents: number; kind: 'refund'; createdAt: string }; balance: Balance } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.bookingId) || !isUuid(input.actorUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 2000000000) {
    return fail(400, 'validation_error', 'Invalid amount', 'invalid_amount');
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.length > 500) {
      return fail(400, 'validation_error', 'Invalid note', 'invalid_note');
    }
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      if (!isManager(actor.role)) {
        return fail(403, 'forbidden', 'Manager required', 'manager_required');
      }

      const lockRes = await client.query(
        `SELECT id FROM bookings WHERE id = $1 FOR UPDATE`,
        [input.bookingId]
      );
      if (lockRes.rows.length === 0) {
        return fail(404, 'not_found', 'Booking not found');
      }

      const balance = await getBalance(client, input.bookingId);
      if (input.amountCents > balance.netPaidCents) {
        return fail(422, 'policy_violation', 'Refund exceeds paid', 'refund_exceeds_paid');
      }

      const payRes = await client.query(
        `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by, note) 
         VALUES ($1, $2, $3, 'refund', $4, $5) RETURNING id, amount_cents, kind, created_at`,
        [input.orgId, input.bookingId, -input.amountCents, actor.id, input.note || null]
      );

      await client.query(`
        INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [input.orgId, actor.id, 'payment.refund', 'payment', payRes.rows[0].id, JSON.stringify({ amountCents: -input.amountCents })]);

      const newBalance = await getBalance(client, input.bookingId);

      return {
        ok: true,
        payment: {
          id: payRes.rows[0].id,
          amountCents: payRes.rows[0].amount_cents,
          kind: payRes.rows[0].kind,
          createdAt: new Date(payRes.rows[0].created_at).toISOString()
        },
        balance: newBalance
      };
    });
  } catch (err: any) {
    throw err;
  }
}