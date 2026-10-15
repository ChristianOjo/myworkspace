import { Pool } from 'pg';
import { withOrg } from '../db/withOrg.js';

export async function runSweepers(
  pool: Pool,
  opts?: { now?: Date; graceMinutes?: number }
): Promise<{ orgs: number; noShows: number; completed: number; errors: { orgId: string; message: string }[] }> {
  const now = opts?.now || new Date();
  const graceMinutes = opts?.graceMinutes ?? 15;

  const orgRes = await pool.query(`SELECT * FROM list_org_ids()`);
  const orgIds = orgRes.rows.map((r: any) => r.id);

  let totalNoShows = 0;
  let totalCompleted = 0;
  const errors: { orgId: string; message: string }[] = [];

  for (const orgId of orgIds) {
    try {
      await withOrg(pool, orgId, async (client) => {
        const noShowRes = await client.query(`
          UPDATE bookings 
          SET status = 'no_show', updated_at = $1 
          WHERE status = 'confirmed' 
            AND (
              (pricing_type = 'hourly' AND lower(period) + make_interval(mins => $2) <= $1)
              OR 
              (pricing_type = 'day' AND upper(period) <= $1)
            )
          RETURNING id
        `, [now.toISOString(), graceMinutes]);

        for (const row of noShowRes.rows) {
          await client.query(`
            INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
            VALUES ($1, NULL, 'booking.no_show', 'booking', $2, $3)
          `, [orgId, row.id, JSON.stringify({ source: 'sweeper' })]);
        }
        totalNoShows += noShowRes.rows.length;

        const completeRes = await client.query(`
          UPDATE bookings 
          SET status = 'completed', updated_at = $1 
          WHERE status = 'checked_in' AND upper(period) <= $1
          RETURNING id
        `, [now.toISOString()]);

        for (const row of completeRes.rows) {
          await client.query(`
            INSERT INTO audit_log (org_id, actor_id, action, entity, entity_id, diff)
            VALUES ($1, NULL, 'booking.complete', 'booking', $2, $3)
          `, [orgId, row.id, JSON.stringify({ source: 'sweeper' })]);
        }
        totalCompleted += completeRes.rows.length;
      });
    } catch (err: any) {
      errors.push({ orgId, message: err.message });
    }
  }

  return { orgs: orgIds.length, noShows: totalNoShows, completed: totalCompleted, errors };
}