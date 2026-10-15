import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';
import { isUuid, fail, loadActor, isManager } from '../common/result.js';

export type StaffRow = {
  userId: string;
  fullName: string;
  paymentsCents: number;
  refundsCents: number;
  netCents: number;
  paymentCount: number;
  refundCount: number;
};

export type Totals = Omit<StaffRow, 'userId' | 'fullName'>;

export async function dailyCashReport(
  pool: Pool,
  input: { orgId: string; locationId: string; date: string; actorUserId: string },
  opts?: { now?: Date }
): Promise<{ ok: true; date: string; locationId: string; timezone: string; staff: StaffRow[]; totals: Totals } | ReturnType<typeof fail>> {
  if (!isUuid(input.orgId) || !isUuid(input.locationId) || !isUuid(input.actorUserId)) {
    return fail(400, 'validation_error', 'Invalid ID', 'invalid_id');
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(input.date)) {
    return fail(400, 'validation_error', 'Invalid date', 'invalid_date');
  }
  const d = new Date(input.date + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.date) {
    return fail(400, 'validation_error', 'Invalid date', 'invalid_date');
  }

  try {
    return await withOrg(pool, input.orgId, async (client) => {
      const actor = await loadActor(client, input.actorUserId);
      if (!('id' in actor)) return actor;

      const locRes = await client.query(
        `SELECT id, timezone FROM locations WHERE id = $1`,
        [input.locationId]
      );
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
        staff_payments AS (
          SELECT 
            u.id AS user_id,
            u.full_name,
            COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE 0 END), 0) AS payments_cents,
            COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN ABS(p.amount_cents) ELSE 0 END), 0) AS refunds_cents,
            COUNT(CASE WHEN p.kind = 'payment' THEN 1 END) AS payment_count,
            COUNT(CASE WHEN p.kind = 'refund' THEN 1 END) AS refund_count
          FROM payments p
          JOIN bookings b ON p.booking_id = b.id
          JOIN resources r ON b.resource_id = r.id
          JOIN users u ON p.received_by = u.id
          CROSS JOIN day_interval di
          WHERE r.location_id = $3
            AND p.created_at >= di.start_tz
            AND p.created_at < di.end_tz
            AND ($4 = true OR p.received_by = $5)
          GROUP BY u.id, u.full_name
        )
        SELECT 
          user_id,
          full_name,
          payments_cents,
          refunds_cents,
          (payments_cents - refunds_cents) AS net_cents,
          payment_count,
          refund_count
        FROM staff_payments
        ORDER BY full_name, user_id
      `;

      const isMgr = isManager(actor.role);
      const res = await client.query(query, [input.date, timezone, input.locationId, isMgr, actor.id]);

      const staff: StaffRow[] = res.rows.map((row: any) => ({
        userId: row.user_id,
        fullName: row.full_name,
        paymentsCents: Number(row.payments_cents),
        refundsCents: Number(row.refunds_cents),
        netCents: Number(row.net_cents),
        paymentCount: Number(row.payment_count),
        refundCount: Number(row.refund_count)
      }));

      const totals: Totals = {
        paymentsCents: staff.reduce((sum, s) => sum + s.paymentsCents, 0),
        refundsCents: staff.reduce((sum, s) => sum + s.refundsCents, 0),
        netCents: staff.reduce((sum, s) => sum + s.netCents, 0),
        paymentCount: staff.reduce((sum, s) => sum + s.paymentCount, 0),
        refundCount: staff.reduce((sum, s) => sum + s.refundCount, 0)
      };

      return {
        ok: true,
        date: input.date,
        locationId: input.locationId,
        timezone,
        staff,
        totals
      };
    });
  } catch (err: any) {
    throw err;
  }
}