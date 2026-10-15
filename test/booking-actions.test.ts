// test/booking-actions.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocation, createResource, createStaff, createBookingRow, insertPaymentAt, auditRows } from './helpers.js';
import { createBooking, CreateBookingInput } from '../src/booking/createBooking.js';
import { markArrived, cancelBooking, releaseBooking } from '../src/booking/actions.js';
import { getBookingBalance } from '../src/cash/payments.js';
import { createAppPool } from '../src/db/pool.js';

const TEST_APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace_test';
const localAppPool = createAppPool(TEST_APP_DATABASE_URL, 25);

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await localAppPool.end();
});

describe('booking-actions', () => {
  it('staff can mark a confirmed booking as arrived inside the check-in window', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const now = new Date('2030-01-07T08:45:00Z');
      const arrived = await markArrived(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now });
      expect(arrived.ok).toBe(true);
      if (arrived.ok) {
        expect(arrived.booking.status).toBe('checked_in');
        expect(arrived.booking.checkinAt).toBe(now.toISOString());
        const dbRes = await testPool.query('SELECT status, checkin_at FROM bookings WHERE id = $1', [res.booking.id]);
        expect(dbRes.rows[0].status).toBe('checked_in');
        const logs = await auditRows(orgId, 'booking.arrived');
        expect(logs.length).toBe(1);
      }
    }
  });

  it('arrived is rejected before the window opens and after the booking ends', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const res1 = await markArrived(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T08:44:59Z') });
      expect(res1.ok).toBe(false);
      if (!res1.ok) expect(res1.reason).toBe('outside_checkin_window');

      const res2 = await markArrived(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T12:00:00Z') });
      expect(res2.ok).toBe(false);
      if (!res2.ok) expect(res2.reason).toBe('booking_ended');
    }
  });

  it('arrived is rejected unless the booking is confirmed', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const res1 = await markArrived(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T09:10:00Z') });
      expect(res1.ok).toBe(false);
      if (!res1.ok) expect(res1.reason).toBe('not_confirmed');
    }
  });

  it('an unknown booking and another org\'s booking return identical not_found', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const staffId = await createStaff(orgA, 'member');
    const locationId = await createLocation(orgB);
    const resourceId = await createResource(orgB, locationId);
    const bookingIdB = await createBookingRow(orgB, await createUser(orgB), resourceId);

    const res1 = await markArrived(localAppPool, { orgId: orgA, bookingId: '00000000-0000-0000-0000-000000000000', actorUserId: staffId });
    const res2 = await markArrived(localAppPool, { orgId: orgA, bookingId: bookingIdB, actorUserId: staffId });

    expect(res1).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Booking not found' });
    expect(res2).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Booking not found' });
  });

  it('staff can cancel an unpaid confirmed booking and the slot is freed', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const cancelRes = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, reason: 'Customer called' });
      expect(cancelRes.ok).toBe(true);
      if (cancelRes.ok) {
        expect(cancelRes.booking.status).toBe('cancelled');
        const logs = await auditRows(orgId, 'booking.cancel');
        expect(logs.length).toBe(1);
        expect(logs[0].diff.reason).toBe('Customer called');

        const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
        const res2 = await createBooking(localAppPool, input2, { now: new Date('2030-01-01T00:00:00Z') });
        expect(res2.ok).toBe(true);
      }
    }
  });

  it('a member cannot cancel a paid booking', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await insertPaymentAt(orgId, res.booking.id, staffId, 'payment', 2000, '2030-01-07T09:00:00Z');
      const cancelRes = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId });
      expect(cancelRes.ok).toBe(false);
      if (!cancelRes.ok) {
        expect(cancelRes.http).toBe(403);
        expect(cancelRes.reason).toBe('manager_required');
      }
    }
  });

  it('a manager can cancel a paid booking without a refund and the cash stays recorded', async () => {
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
      await insertPaymentAt(orgId, res.booking.id, staffId, 'payment', 2000, '2030-01-07T09:00:00Z');
      const cancelRes = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId });
      expect(cancelRes.ok).toBe(true);
      if (cancelRes.ok) {
        const balance = await getBookingBalance(localAppPool, { orgId, bookingId: res.booking.id });
        expect(balance.ok).toBe(true);
        if (balance.ok) {
          expect(balance.balance.netPaidCents).toBe(2000);
          expect(balance.balance.dueCents).toBe(0);
          expect(balance.balance.paymentStatus).toBe('void');
        }
      }
    }
  });

  it('a manager can cancel and refund in one step', async () => {
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
      const cancelRes = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId, refundCents: 3000 });
      expect(cancelRes.ok).toBe(true);
      if (cancelRes.ok) {
        expect(cancelRes.refund).not.toBeNull();
        const balance = await getBookingBalance(localAppPool, { orgId, bookingId: res.booking.id });
        expect(balance.ok).toBe(true);
        if (balance.ok) expect(balance.balance.netPaidCents).toBe(2000);
        const logs = await auditRows(orgId);
        expect(logs.some((l: any) => l.action === 'booking.cancel')).toBe(true);
        expect(logs.some((l: any) => l.action === 'payment.refund')).toBe(true);
      }
    }
  });

  it('cancel with a refund checks role and amount', async () => {
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
      
      const res1 = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: mgrId, refundCents: 6000 });
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.http).toBe(422);
        expect(res1.reason).toBe('refund_exceeds_paid');
      }

      const res2 = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId, refundCents: 100 });
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.http).toBe(403);
        expect(res2.reason).toBe('manager_required');
      }
    }
  });

  it('only confirmed bookings can be cancelled', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const cancelRes = await cancelBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId });
      expect(cancelRes.ok).toBe(false);
      if (!cancelRes.ok) {
        expect(cancelRes.http).toBe(409);
        expect(cancelRes.reason).toBe('use_release');
      }
    }
  });

  it('release truncates to the next 15-minute boundary and frees the rest', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T17:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const releaseRes = await releaseBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T11:07:00Z') });
      expect(releaseRes.ok).toBe(true);
      if (releaseRes.ok) {
        expect(releaseRes.booking.status).toBe('completed');
        expect(releaseRes.booking.end).toBe('2030-01-07T11:15:00.000Z');
        expect(releaseRes.booking.releasedBeforeStart).toBe(false);
        const logs = await auditRows(orgId, 'booking.release');
        expect(logs.length).toBe(1);

        const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T11:15:00Z', end: '2030-01-07T12:00:00Z' };
        const res2 = await createBooking(localAppPool, input2, { now: new Date('2030-01-01T00:00:00Z') });
        expect(res2.ok).toBe(true);

        const input3: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T11:00:00Z', end: '2030-01-07T11:15:00Z' };
        const res3 = await createBooking(localAppPool, input3, { now: new Date('2030-01-01T00:00:00Z') });
        expect(res3.ok).toBe(true);
      }
    }
  });

  it('release at or after the end keeps the period', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const releaseRes = await releaseBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T10:30:00Z') });
      expect(releaseRes.ok).toBe(true);
      if (releaseRes.ok) {
        expect(releaseRes.booking.status).toBe('completed');
        expect(releaseRes.booking.end).toBe('2030-01-07T10:00:00.000Z');
      }
    }
  });

  it('release before the start is a cancel without refund', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await markArrived(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T08:50:00Z') });
      await insertPaymentAt(orgId, res.booking.id, staffId, 'payment', 2000, '2030-01-07T08:50:00Z');
      const releaseRes = await releaseBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T08:55:00Z') });
      expect(releaseRes.ok).toBe(true);
      if (releaseRes.ok) {
        expect(releaseRes.booking.status).toBe('cancelled');
        expect(releaseRes.booking.releasedBeforeStart).toBe(true);
        
        const dbRes = await testPool.query('SELECT cancellation_reason FROM bookings WHERE id = $1', [res.booking.id]);
        expect(dbRes.rows[0].cancellation_reason).toBe('released_before_start');

        const balance = await getBookingBalance(localAppPool, { orgId, bookingId: res.booking.id });
        expect(balance.ok).toBe(true);
        if (balance.ok) expect(balance.balance.netPaidCents).toBe(2000);
      }
    }
  });

  it('release exactly on a boundary keeps that boundary', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const releaseRes = await releaseBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId }, { now: new Date('2030-01-07T11:15:00.000Z') });
      expect(releaseRes.ok).toBe(true);
      if (releaseRes.ok) {
        expect(releaseRes.booking.end).toBe('2030-01-07T11:15:00.000Z');
      }
    }
  });

  it('release only works on checked_in bookings', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const staffId = await createStaff(orgId, 'member');
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const releaseRes = await releaseBooking(localAppPool, { orgId, bookingId: res.booking.id, actorUserId: staffId });
      expect(releaseRes.ok).toBe(false);
      if (!releaseRes.ok) {
        expect(releaseRes.http).toBe(409);
        expect(releaseRes.reason).toBe('not_checked_in');
      }
    }
  });
});