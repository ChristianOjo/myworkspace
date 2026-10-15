import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool, createOrg, createUser, createLocationCustom, createResource, loginAs, auditRows } from './helpers.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';
import { runSweepers } from '../src/jobs/sweepers.js';
import { markArrived } from '../src/booking/actions.js';

let clock = new Date('2030-01-07T08:00:00Z');

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await appPool.end();
});

describe('sweepers', () => {
  it('a confirmed hourly booking becomes no_show after the grace period', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    const bookingId = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`, [orgId, userId, resId]).then(r => r.rows[0].id);

    clock = new Date('2030-01-07T09:14:59Z');
    await runSweepers(appPool, { now: clock });
    let status = await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]).then(r => r.rows[0].status);
    expect(status).toBe('confirmed');

    clock = new Date('2030-01-07T09:15:00Z');
    await runSweepers(appPool, { now: clock });
    status = await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]).then(r => r.rows[0].status);
    expect(status).toBe('no_show');

    const logs = await auditRows(orgId, 'booking.no_show');
    expect(logs.length).toBe(1);
    expect(logs[0].actor_id).toBeNull();
    expect(logs[0].diff.source).toBe('sweeper');
  });

  it('an arrived booking is not a no_show', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    const bookingId = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`, [orgId, userId, resId]).then(r => r.rows[0].id);
    await testPool.query(`UPDATE bookings SET status = 'checked_in' WHERE id = $1`, [bookingId]);

    clock = new Date('2030-01-07T09:30:00Z');
    await runSweepers(appPool, { now: clock });
    const status = await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId]).then(r => r.rows[0].status);
    expect(status).toBe('checked_in');
  });

  it('a day booking becomes no_show only when the day ends', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '08:00', closeHour: '20:00' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    const bookingId = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status, pricing_type) VALUES ($1, $2, $3, tstzrange('2030-01-07T08:00:00Z', '2030-01-07T20:00:00Z', '[)'), 'confirmed', 'day') RETURNING id`, [orgId, userId, resId]).then(r => r.rows[0].id);

    clock = new Date('2030-01-07T12:00:00Z');
    await runSweepers(appPool, { now: clock });
    expect((await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status).toBe('confirmed');

    clock = new Date('2030-01-07T19:59:59Z');
    await runSweepers(appPool, { now: clock });
    expect((await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status).toBe('confirmed');

    clock = new Date('2030-01-07T20:00:00Z');
    await runSweepers(appPool, { now: clock });
    expect((await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status).toBe('no_show');
  });

  it('checked_in bookings complete at their end time', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    const bookingId = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'checked_in') RETURNING id`, [orgId, userId, resId]).then(r => r.rows[0].id);

    clock = new Date('2030-01-07T09:59:59Z');
    await runSweepers(appPool, { now: clock });
    expect((await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status).toBe('checked_in');

    clock = new Date('2030-01-07T10:00:00Z');
    await runSweepers(appPool, { now: clock });
    expect((await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status).toBe('completed');

    const logs = await auditRows(orgId, 'booking.complete');
    expect(logs.length).toBe(1);
  });

  it('a no_show slot can be booked again', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);
    clock = new Date('2030-01-07T09:15:00Z');
    await runSweepers(appPool, { now: clock });

    const newBooking = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:30:00Z', '2030-01-07T10:30:00Z', '[)'), 'confirmed') RETURNING id`, [orgId, userId, resId]);
    expect(newBooking.rows.length).toBe(1);
  });

  it('paid no-shows keep their payments', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    const bookingId = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`, [orgId, userId, resId]).then(r => r.rows[0].id);
    await testPool.query(`INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, 2000, 'payment', $3)`, [orgId, bookingId, userId]);

    clock = new Date('2030-01-07T09:15:00Z');
    await runSweepers(appPool, { now: clock });

    const payCount = await testPool.query('SELECT count(*) FROM payments WHERE booking_id = $1', [bookingId]);
    expect(Number(payCount.rows[0].count)).toBe(1);
  });

  it('sweepers handle every org and keep orgs separate', async () => {
    const { orgId: orgA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'b', adminEmail: 'b@b.b', adminName: 'B' });
    
    const setup = async (orgId: string) => {
      const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
      const resId = await createResource(orgId, locId);
      const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;
      await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);
    };
    await setup(orgA);
    await setup(orgB);

    clock = new Date('2030-01-07T09:15:00Z');
    const result = await runSweepers(appPool, { now: clock });
    
    expect(result.orgs).toBeGreaterThanOrEqual(2);
    expect(result.noShows).toBe(2);
    
    const logsA = await auditRows(orgA, 'booking.no_show');
    const logsB = await auditRows(orgB, 'booking.no_show');
    expect(logsA.length).toBe(1);
    expect(logsB.length).toBe(1);
    expect(logsA[0].org_id).toBe(orgA);
    expect(logsB[0].org_id).toBe(orgB);
  });

  it('the sweeper and mark-arrived race leaves exactly one outcome', async () => {
    for (let i = 0; i < 5; i++) {
      const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
      const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
      const resId = await createResource(orgId, locId);
      const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

      const bookingId = await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`, [orgId, userId, resId]).then(r => r.rows[0].id);

      clock = new Date('2030-01-07T09:20:00Z');
      await Promise.all([
        markArrived(appPool, { orgId, bookingId, actorUserId: userId }, { now: clock }),
        runSweepers(appPool, { now: clock })
      ]);

      const status = (await testPool.query('SELECT status FROM bookings WHERE id = $1', [bookingId])).rows[0].status;
      expect(['checked_in', 'no_show']).toContain(status);

      const logs = await auditRows(orgId);
      const noShowLogs = logs.filter((l: any) => l.action === 'booking.no_show');
      const arrivedLogs = logs.filter((l: any) => l.action === 'booking.arrived');
      expect(noShowLogs.length + arrivedLogs.length).toBeLessThanOrEqual(1);
    }
  });

  it('running the sweepers twice changes nothing the second time', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);

    clock = new Date('2030-01-07T09:15:00Z');
    const res1 = await runSweepers(appPool, { now: clock });
    const res2 = await runSweepers(appPool, { now: clock });

    expect(res2.noShows).toBe(0);
    expect(res2.completed).toBe(0);
  });

  it('the sweeper only touches due bookings', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T11:00:00Z', '2030-01-07T12:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'cancelled')`, [orgId, userId, resId]);
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'completed')`, [orgId, userId, resId]);
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'no_show')`, [orgId, userId, resId]);

    clock = new Date('2030-01-07T09:15:00Z');
    await runSweepers(appPool, { now: clock });

    const counts = await testPool.query(`SELECT status, count(*) FROM bookings GROUP BY status`);
    const statusMap = Object.fromEntries(counts.rows.map((r: any) => [r.status, Number(r.count)]));
    expect(statusMap['confirmed']).toBe(1);
    expect(statusMap['cancelled']).toBe(1);
    expect(statusMap['completed']).toBe(1);
    expect(statusMap['no_show']).toBe(1);
  });

  it('one failing org does not stop the others', async () => {
    const { orgId: orgA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'b', adminEmail: 'b@b.b', adminName: 'B' });
    
    const setup = async (orgId: string) => {
      const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
      const resId = await createResource(orgId, locId);
      const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;
      await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);
    };
    await setup(orgA);
    await setup(orgB);

    await testPool.query(`CREATE OR REPLACE FUNCTION fail_org_a() RETURNS trigger AS $$ BEGIN IF NEW.org_id = '${orgA}' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await testPool.query(`CREATE TRIGGER fail_org_a_trigger BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION fail_org_a()`);

    clock = new Date('2030-01-07T09:15:00Z');
    const result = await runSweepers(appPool, { now: clock });

    await testPool.query(`DROP TRIGGER fail_org_a_trigger ON bookings`);
    await testPool.query(`DROP FUNCTION fail_org_a()`);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].orgId).toBe(orgA);
    
    const statusB = (await testPool.query(`SELECT status FROM bookings WHERE org_id = $1`, [orgB])).rows[0].status;
    expect(statusB).toBe('no_show');
  });
});