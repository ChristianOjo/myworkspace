// test/cash.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocation, createResource, createStaff, deactivateUser, insertPaymentAt, setResourceRates } from './helpers.js';
import { createBooking, CreateBookingInput } from '../src/booking/createBooking.js';
import { recordPayment, recordRefund, getBookingBalance } from '../src/cash/payments.js';
import { createAppPool } from '../src/db/pool.js';

const TEST_APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace_test';
const localAppPool = createAppPool(TEST_APP_DATABASE_URL, 25);

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await localAppPool.end();
});

describe('cash', () => {
  it('partial then final payment reports paid', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await testPool.query(`UPDATE resources SET hourly_rate_cents = 5000 WHERE id = $1`, [resourceId]);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const pay1 = await recordPayment(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 5000 });
      expect(pay1.ok).toBe(true);
      if (pay1.ok) {
        expect(pay1.balance.paymentStatus).toBe('partial');
        expect(pay1.balance.dueCents).toBe(10000);
      }

      const pay2 = await recordPayment(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 10000 });
      expect(pay2.ok).toBe(true);
      if (pay2.ok) {
        expect(pay2.balance.paymentStatus).toBe('paid');
        expect(pay2.balance.dueCents).toBe(0);
        expect(pay2.balance.netPaidCents).toBe(15000);
      }
    }
  });

  it('overpayment is rejected and writes nothing', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await testPool.query(`UPDATE resources SET hourly_rate_cents = 5000 WHERE id = $1`, [resourceId]);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const pay = await recordPayment(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 15001 });
      expect(pay.ok).toBe(false);
      if (!pay.ok) expect(pay.reason).toBe('overpayment');
      
      const count = await testPool.query(`SELECT count(*) FROM payments WHERE booking_id = $1`, [res.booking.id]);
      expect(Number(count.rows[0].count)).toBe(0);
    }
  });

  it('non-positive and non-integer amounts are rejected', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await testPool.query(
      `INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`,
      [orgId, userId, resourceId]
    ).then(r => r.rows[0].id);

    const amounts = [0, -5, 10.5, '100' as any];
    for (const amt of amounts) {
      const res = await recordPayment(localAppPool, { orgId, bookingId, actorUserId: staffId, amountCents: amt });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('invalid_amount');
    }
  });

  it('a zero-price booking reports paid', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await testPool.query(`UPDATE resources SET hourly_rate_cents = 0 WHERE id = $1`, [resourceId]);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const balance = await getBookingBalance(localAppPool, { orgId, bookingId: res.booking.id });
      expect(balance.ok).toBe(true);
      if (balance.ok) {
        expect(balance.balance.paymentStatus).toBe('paid');
        expect(balance.balance.dueCents).toBe(0);
      }
    }
  });

  it('payments are rejected on cancelled bookings', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await testPool.query(
      `INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'cancelled') RETURNING id`,
      [orgId, userId, resourceId]
    ).then(r => r.rows[0].id);

    const res = await recordPayment(localAppPool, { orgId, bookingId, actorUserId: staffId, amountCents: 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('booking_not_payable');
  });

  it('a member cannot refund and a manager can', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const mgrId = await createStaff(orgId, 'location_manager');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await insertPaymentAt(orgId, res.booking.id, staffId, 'payment', 5000, '2030-01-07T09:00:00Z');

      const res1 = await recordRefund(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 2000 });
      expect(res1.ok).toBe(false);
      if (!res1.ok) expect(res1.reason).toBe('manager_required');

      const res2 = await recordRefund(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId, amountCents: 2000 });
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.payment.amountCents).toBe(-2000);
        expect(res2.payment.kind).toBe('refund');
        expect(res2.balance.netPaidCents).toBe(3000);
        expect(res2.balance.refundedCents).toBe(2000);
      }
    }
  });

  it('a refund cannot exceed the net amount paid', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const mgrId = await createStaff(orgId, 'location_manager');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await insertPaymentAt(orgId, res.booking.id, staffId, 'payment', 5000, '2030-01-07T09:00:00Z');

      const res1 = await recordRefund(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId, amountCents: 3000 });
      expect(res1.ok).toBe(true);

      const res2 = await recordRefund(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId, amountCents: 3000 });
      expect(res2.ok).toBe(false);
      if (!res2.ok) expect(res2.reason).toBe('refund_exceeds_paid');
    }
  });

  it('unknown and deactivated actors are rejected', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await testPool.query(
      `INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`,
      [orgId, userId, resourceId]
    ).then(r => r.rows[0].id);

    const res1 = await recordPayment(localAppPool, { orgId, bookingId, actorUserId: '00000000-0000-0000-0000-000000000000', amountCents: 1000 });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('unknown_actor');

    await deactivateUser(staffId);
    const res2 = await recordPayment(localAppPool, { orgId, bookingId, actorUserId: staffId, amountCents: 1000 });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('actor_inactive');
  });

  it('another org\'s booking returns not_found', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const staffId = await createStaff(orgA, 'member');
    const locationId = await createLocation(orgB);
    const resourceId = await createResource(orgB, locationId);
    const bookingIdB = await testPool.query(
      `INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`,
      [orgB, await createUser(orgB), resourceId]
    ).then(r => r.rows[0].id);

    const res1 = await recordPayment(localAppPool, { orgId: orgA, bookingId: '00000000-0000-0000-0000-000000000000', actorUserId: staffId, amountCents: 1000 });
    const res2 = await recordPayment(localAppPool, { orgId: orgA, bookingId: bookingIdB, actorUserId: staffId, amountCents: 1000 });

    expect(res1).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Booking not found' });
    expect(res2).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Booking not found' });
  });

  it('every payment and refund writes an audit row', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'location_manager');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 5000, 40000);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const payRes = await recordPayment(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 5000 });
      expect(payRes).toMatchObject({ ok: true });
      
      const refRes = await recordRefund(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 2000 });
      expect(refRes).toMatchObject({ ok: true });

      if (payRes.ok && refRes.ok) {
        const logs = await testPool.query(`SELECT * FROM audit_log WHERE org_id = $1 AND actor_id = $2 ORDER BY id`, [orgId, staffId]);
        expect(logs.rows.some((r: any) => r.action === 'payment.record' && r.entity_id === payRes.payment.id)).toBe(true);
        expect(logs.rows.some((r: any) => r.action === 'payment.refund' && r.entity_id === refRes.payment.id)).toBe(true);
      }
    }
  });

  it('concurrent payments cannot exceed the price', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await testPool.query(`UPDATE bookings SET price_cents = 10000 WHERE id = $1`, [res.booking.id]);
      await testPool.query(`UPDATE resources SET hourly_rate_cents = 10000 WHERE id = $1`, [resourceId]);

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(recordPayment(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, amountCents: 4000 }));
      }
      const results = await Promise.all(promises);
      const okCount = results.filter(r => r.ok).length;
      const overpayCount = results.filter(r => !r.ok && r.reason === 'overpayment').length;
      expect(okCount).toBe(2);
      expect(overpayCount).toBe(3);

      const balance = await getBookingBalance(localAppPool, { orgId, bookingId: res.booking.id });
      expect(balance.ok).toBe(true);
      if (balance.ok) expect(balance.balance.netPaidCents).toBe(8000);
    }
  });

  it('concurrent refunds cannot exceed what was paid', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const mgrId = await createStaff(orgId, 'location_manager');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await insertPaymentAt(orgId, res.booking.id, staffId, 'payment', 6000, '2030-01-07T09:00:00Z');

      const promises = [];
      for (let i = 0; i < 4; i++) {
        promises.push(recordRefund(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId, amountCents: 2500 }));
      }
      const results = await Promise.all(promises);
      const okCount = results.filter(r => r.ok).length;
      const exceedCount = results.filter(r => !r.ok && r.reason === 'refund_exceeds_paid').length;
      expect(okCount).toBe(2);
      expect(exceedCount).toBe(2);

      const balance = await getBookingBalance(localAppPool, { orgId, bookingId: res.booking.id });
      expect(balance.ok).toBe(true);
      if (balance.ok) expect(balance.balance.netPaidCents).toBe(1000);
    }
  });
});