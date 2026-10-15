// test/cash-report.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocationCustom, createResource, createStaff, createBookingRow, insertPaymentAt } from './helpers.js';
import { dailyCashReport } from '../src/cash/report.js';
import { createAppPool } from '../src/db/pool.js';

const TEST_APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace_test';
const localAppPool = createAppPool(TEST_APP_DATABASE_URL, 25);

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await localAppPool.end();
});

describe('cash-report', () => {
  it('totals per staff member for the day', async () => {
    const orgId = await createOrg();
    const member1Id = await createStaff(orgId, 'member', 'Alice');
    const member2Id = await createStaff(orgId, 'member', 'Bob');
    const mgrId = await createStaff(orgId, 'location_manager', 'Charlie');
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await createBookingRow(orgId, await createUser(orgId), resourceId);

    await insertPaymentAt(orgId, bookingId, member1Id, 'payment', 5000, '2030-01-07T10:00:00Z');
    await insertPaymentAt(orgId, bookingId, member1Id, 'payment', 3000, '2030-01-07T11:00:00Z');
    await insertPaymentAt(orgId, bookingId, member2Id, 'payment', 4000, '2030-01-07T12:00:00Z');
    await insertPaymentAt(orgId, bookingId, mgrId, 'refund', -1000, '2030-01-07T13:00:00Z');

    const report = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-01-07', actorUserId: mgrId });
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.staff.length).toBe(3);
      expect(report.staff[0].fullName).toBe('Alice');
      expect(report.staff[0].paymentsCents).toBe(8000);
      expect(report.staff[0].refundsCents).toBe(0);
      expect(report.staff[0].netCents).toBe(8000);
      expect(report.staff[0].paymentCount).toBe(2);
      expect(report.staff[0].refundCount).toBe(0);

      expect(report.staff[1].fullName).toBe('Bob');
      expect(report.staff[1].paymentsCents).toBe(4000);

      expect(report.staff[2].fullName).toBe('Charlie');
      expect(report.staff[2].refundsCents).toBe(1000);
      expect(report.staff[2].refundCount).toBe(1);

      expect(report.totals.paymentsCents).toBe(12000);
      expect(report.totals.refundsCents).toBe(1000);
      expect(report.totals.netCents).toBe(11000);
    }
  });

  it('payments either side of local midnight fall on different days', async () => {
    const orgId = await createOrg();
    const staffId = await createStaff(orgId, 'member', 'Alice');
    const locationId = await createLocationCustom(orgId, { timezone: 'America/New_York' });
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await createBookingRow(orgId, await createUser(orgId), resourceId);

    await insertPaymentAt(orgId, bookingId, staffId, 'payment', 1000, '2030-01-08T04:59:00Z');
    await insertPaymentAt(orgId, bookingId, staffId, 'payment', 2000, '2030-01-08T05:01:00Z');

    const report7 = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-01-07', actorUserId: staffId });
    expect(report7.ok).toBe(true);
    if (report7.ok) expect(report7.totals.paymentsCents).toBe(1000);

    const report8 = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-01-08', actorUserId: staffId });
    expect(report8.ok).toBe(true);
    if (report8.ok) expect(report8.totals.paymentsCents).toBe(2000);
  });

  it('daylight saving days are measured in local time', async () => {
    const orgId = await createOrg();
    const staffId = await createStaff(orgId, 'member', 'Alice');
    const locationId = await createLocationCustom(orgId, { timezone: 'America/New_York' });
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await createBookingRow(orgId, await createUser(orgId), resourceId);

    await insertPaymentAt(orgId, bookingId, staffId, 'payment', 1000, '2030-03-10T04:59:00Z');
    await insertPaymentAt(orgId, bookingId, staffId, 'payment', 2000, '2030-03-11T03:59:00Z');
    await insertPaymentAt(orgId, bookingId, staffId, 'payment', 3000, '2030-03-11T04:00:00Z');

    const report9 = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-03-09', actorUserId: staffId });
    expect(report9.ok).toBe(true);
    if (report9.ok) expect(report9.totals.paymentsCents).toBe(1000);

    const report10 = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-03-10', actorUserId: staffId });
    expect(report10.ok).toBe(true);
    if (report10.ok) expect(report10.totals.paymentsCents).toBe(2000);

    const report11 = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-03-11', actorUserId: staffId });
    expect(report11.ok).toBe(true);
    if (report11.ok) expect(report11.totals.paymentsCents).toBe(3000);
  });

  it('a member sees only their own row, a manager sees everyone', async () => {
    const orgId = await createOrg();
    const member1Id = await createStaff(orgId, 'member', 'Alice');
    const mgrId = await createStaff(orgId, 'location_manager', 'Charlie');
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resourceId = await createResource(orgId, locationId);
    const bookingId = await createBookingRow(orgId, await createUser(orgId), resourceId);

    await insertPaymentAt(orgId, bookingId, member1Id, 'payment', 5000, '2030-01-07T10:00:00Z');
    await insertPaymentAt(orgId, bookingId, mgrId, 'payment', 3000, '2030-01-07T11:00:00Z');

    const memberReport = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-01-07', actorUserId: member1Id });
    expect(memberReport.ok).toBe(true);
    if (memberReport.ok) {
      expect(memberReport.staff.length).toBe(1);
      expect(memberReport.staff[0].userId).toBe(member1Id);
      expect(memberReport.totals.paymentsCents).toBe(5000);
    }

    const mgrReport = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-01-07', actorUserId: mgrId });
    expect(mgrReport.ok).toBe(true);
    if (mgrReport.ok) {
      expect(mgrReport.staff.length).toBe(2);
      expect(mgrReport.totals.paymentsCents).toBe(8000);
    }
  });

  it('other locations and other orgs are excluded', async () => {
    const orgA = await createOrg();
    const staffId = await createStaff(orgA, 'member', 'Alice');
    const locationIdA = await createLocationCustom(orgA, { timezone: 'UTC' });
    const resourceIdA = await createResource(orgA, locationIdA);
    const bookingIdA = await createBookingRow(orgA, await createUser(orgA), resourceIdA);
    await insertPaymentAt(orgA, bookingIdA, staffId, 'payment', 5000, '2030-01-07T10:00:00Z');

    const locationIdA2 = await createLocationCustom(orgA, { timezone: 'UTC' });
    const resourceIdA2 = await createResource(orgA, locationIdA2);
    const bookingIdA2 = await createBookingRow(orgA, await createUser(orgA), resourceIdA2);
    await insertPaymentAt(orgA, bookingIdA2, staffId, 'payment', 5000, '2030-01-07T10:00:00Z');

    const orgB = await createOrg();
    const locationIdB = await createLocationCustom(orgB, { timezone: 'UTC' });
    const resourceIdB = await createResource(orgB, locationIdB);
    const bookingIdB = await createBookingRow(orgB, await createUser(orgB), resourceIdB);
    await insertPaymentAt(orgB, bookingIdB, await createStaff(orgB, 'member', 'Bob'), 'payment', 5000, '2030-01-07T10:00:00Z');

    const report = await dailyCashReport(localAppPool, { orgId: orgA, locationId: locationIdA, date: '2030-01-07', actorUserId: staffId });
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.totals.paymentsCents).toBe(5000);

    const res1 = await dailyCashReport(localAppPool, { orgId: orgA, locationId: '00000000-0000-0000-0000-000000000000', date: '2030-01-07', actorUserId: staffId });
    const res2 = await dailyCashReport(localAppPool, { orgId: orgA, locationId: locationIdB, date: '2030-01-07', actorUserId: staffId });
    expect(res1).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Location not found' });
    expect(res2).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Location not found' });
  });

  it('an empty day returns zeros and no staff rows', async () => {
    const orgId = await createOrg();
    const staffId = await createStaff(orgId, 'member', 'Alice');
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC' });

    const report = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-01-08', actorUserId: staffId });
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.staff.length).toBe(0);
      expect(report.totals.paymentsCents).toBe(0);
      expect(report.totals.refundsCents).toBe(0);
      expect(report.totals.netCents).toBe(0);
    }
  });

  it('an invalid date is rejected', async () => {
    const orgId = await createOrg();
    const staffId = await createStaff(orgId, 'member', 'Alice');
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC' });

    const res1 = await dailyCashReport(localAppPool, { orgId, locationId, date: '2030-02-30', actorUserId: staffId });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('invalid_date');

    const res2 = await dailyCashReport(localAppPool, { orgId, locationId, date: 'yesterday', actorUserId: staffId });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('invalid_date');
  });
});