// src/booking/customer.ts
// Self-service booking operations for logged-in customers.
// A customer books against their own account: the walk-in name/phone fields on
// the booking are filled from the profile (with an optional phone override),
// customers cannot mark themselves arrived, and they may cancel only their own
// confirmed, unpaid, upcoming bookings.
import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { createBooking, type Booking } from './createBooking.js';
import { cancelBooking } from './actions.js';
import { fail, Failure, isUuid } from '../common/result.js';

export interface MyBooking {
  id: string;
  resourceId: string;
  resourceName: string;
  type: string;
  locationId: string;
  locationName: string;
  timezone: string;
  start: string;
  end: string;
  status: string;
  pricing: 'hourly' | 'day';
  priceCents: number;
  customerPhone: string | null;
  checkinAt: string | null;
  createdAt: string;
  cancelable: boolean;
}

type ListResult = { ok: true; bookings: MyBooking[] } | Failure;
type DetailResult = { ok: true; booking: MyBooking } | Failure;

function mapBooking(row: any, now: Date): MyBooking {
  const paidCents = Number(row.paid_cents);
  const refundedCents = Number(row.refunded_cents);
  const netPaidCents = paidCents - refundedCents;
  const startMs = new Date(row.start).getTime();
  const cancelable =
    row.status === 'confirmed' && netPaidCents === 0 && startMs > now.getTime();

  return {
    id: row.id,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    type: row.type,
    locationId: row.location_id,
    locationName: row.location_name,
    timezone: row.timezone,
    start: new Date(row.start).toISOString(),
    end: new Date(row.end).toISOString(),
    status: row.status,
    pricing: row.pricing_type,
    priceCents: Number(row.price_cents),
    customerPhone: row.customer_phone,
    checkinAt: row.checkin_at ? new Date(row.checkin_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    cancelable
  };
}

const SELECT_BASE_SQL = `
  SELECT b.id, b.resource_id, r.name AS resource_name, r.type, r.location_id, l.name AS location_name, l.timezone AS timezone,
         lower(b.period) AS start, upper(b.period) AS "end", b.status, b.price_cents, b.pricing_type,
         b.customer_phone, b.checkin_at, b.created_at,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE 0 END), 0) AS paid_cents,
         COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN ABS(p.amount_cents) ELSE 0 END), 0) AS refunded_cents
  FROM bookings b
  JOIN resources r ON r.id = b.resource_id
  JOIN locations l ON l.id = r.location_id
  LEFT JOIN payments p ON p.booking_id = b.id
`;

const GROUP_BY_SQL = `GROUP BY b.id, r.name, r.type, r.location_id, l.name, l.timezone`;

export async function createCustomerBooking(
  pool: Pool,
  input: {
    orgId: string;
    userId: string;
    resourceId: string;
    kind?: 'hourly' | 'day';
    start?: string;
    end?: string;
    date?: string;
    phone?: string;
  },
  opts?: { now?: Date }
): Promise<{ ok: true; booking: Booking } | Failure> {
  if (!isUuid(input.orgId) || !isUuid(input.userId) || !isUuid(input.resourceId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  const profile = await withOrg(pool, input.orgId, async (client) => {
    const res = await client.query(
      `SELECT full_name, phone, role, deactivated_at FROM users WHERE id = $1`,
      [input.userId]
    );
    return res.rows[0] || null;
  });

  if (!profile) {
    return fail(404, 'not_found', 'Account not found', 'unknown_actor');
  }
  if (profile.role !== 'customer') {
    return fail(403, 'forbidden', 'Customer account required', 'customer_required');
  }
  if (profile.deactivated_at !== null) {
    return fail(403, 'forbidden', 'Account inactive', 'actor_inactive');
  }

  const phone = input.phone !== undefined && input.phone.trim() !== ''
    ? input.phone.trim()
    : profile.phone;

  return createBooking(
    pool,
    {
      orgId: input.orgId,
      userId: input.userId,
      resourceId: input.resourceId,
      kind: input.kind,
      start: input.start,
      end: input.end,
      date: input.date,
      customerName: profile.full_name,
      customerPhone: phone ?? undefined,
      arrivedNow: false,
      auditAction: 'customer_booking.create'
    },
    opts
  );
}

export async function listMyBookings(
  pool: Pool,
  input: { orgId: string; userId: string },
  opts?: { now?: Date }
): Promise<ListResult> {
  if (!isUuid(input.orgId) || !isUuid(input.userId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  const now = opts?.now || new Date();

  return withOrg(pool, input.orgId, async (client) => {
    const res = await client.query(
      `${SELECT_BASE_SQL}
       WHERE b.user_id = $1
       ${GROUP_BY_SQL}
       ORDER BY (upper(b.period) > $2) DESC, lower(b.period) ASC`,
      [input.userId, now.toISOString()]
    );
    return { ok: true, bookings: res.rows.map((row: any) => mapBooking(row, now)) };
  });
}

export async function getMyBooking(
  pool: Pool,
  input: { orgId: string; userId: string; bookingId: string },
  opts?: { now?: Date }
): Promise<DetailResult> {
  if (!isUuid(input.orgId) || !isUuid(input.userId) || !isUuid(input.bookingId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  const now = opts?.now || new Date();

  return withOrg(pool, input.orgId, async (client) => {
    const res = await client.query(
      `${SELECT_BASE_SQL}
       WHERE b.user_id = $1 AND b.id = $2
       ${GROUP_BY_SQL}`,
      [input.userId, input.bookingId]
    );
    if (res.rows.length === 0) {
      return fail(404, 'not_found', 'Booking not found', 'booking_not_found');
    }
    return { ok: true, booking: mapBooking(res.rows[0], now) };
  });
}

export async function cancelMyBooking(
  pool: Pool,
  input: { orgId: string; userId: string; bookingId: string; reason?: string },
  opts?: { now?: Date }
): Promise<{ ok: true; booking: { id: string; status: 'cancelled' } } | Failure> {
  if (!isUuid(input.orgId) || !isUuid(input.userId) || !isUuid(input.bookingId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }
  if (input.reason !== undefined) {
    const trimmed = String(input.reason).trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      return fail(400, 'validation_error', 'Invalid reason', 'invalid_reason');
    }
  }
  const now = opts?.now || new Date();

  const guard = await withOrg(pool, input.orgId, async (client) => {
    const lock = await client.query(
      `SELECT b.id, b.status, b.user_id, lower(b.period) AS start,
              COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN ABS(p.amount_cents) ELSE 0 END), 0) AS net_paid
       FROM bookings b
       LEFT JOIN payments p ON p.booking_id = b.id
       WHERE b.id = $1
       GROUP BY b.id
       FOR UPDATE`,
      [input.bookingId]
    );
    if (lock.rows.length === 0 || lock.rows[0].user_id !== input.userId) {
      return fail(404, 'not_found', 'Booking not found', 'booking_not_found');
    }
    const booking = lock.rows[0];
    if (booking.status !== 'confirmed') {
      return fail(409, 'invalid_state', 'Only a confirmed booking can be cancelled', 'not_confirmed');
    }
    if (new Date(booking.start).getTime() <= now.getTime()) {
      return fail(422, 'policy_violation', 'This booking has already started', 'already_started');
    }
    if (Number(booking.net_paid) > 0) {
      return fail(422, 'policy_violation', 'Paid bookings are cancelled by staff', 'paid_booking_cancel');
    }
    return { ok: true as const };
  });

  if (!guard.ok) return guard;

  const result = await cancelBooking(
    pool,
    {
      orgId: input.orgId,
      bookingId: input.bookingId,
      actorUserId: input.userId,
      reason: input.reason ? input.reason.trim() : undefined
    },
    opts
  );
  return result;
}
