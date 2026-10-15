import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocation, createLocationCustom, createResource, setResourceRates, auditRows } from './helpers.js';
import { createBooking, CreateBookingInput } from '../src/booking/createBooking.js';
import { createAppPool } from '../src/db/pool.js';

const TEST_APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace_test';
const localAppPool = createAppPool(TEST_APP_DATABASE_URL, 25);

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await localAppPool.end();
});

describe('walk-in', () => {
  it('the current 15-minute slot can be booked', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId1 = await createResource(orgId, locationId);
    const resourceId2 = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId: resourceId1, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res1.ok).toBe(true);

    const input2: CreateBookingInput = { orgId, userId, resourceId: resourceId2, start: '2030-01-07T08:45:00Z', end: '2030-01-07T09:45:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('in_the_past');
  });

  it('the slot boundary is exact', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId1 = await createResource(orgId, locationId);
    const resourceId2 = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId: resourceId1, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: new Date('2030-01-07T09:15:00Z') });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('in_the_past');

    const input2: CreateBookingInput = { orgId, userId, resourceId: resourceId2, start: '2030-01-07T09:15:00Z', end: '2030-01-07T10:15:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: new Date('2030-01-07T09:15:00Z') });
    expect(res2.ok).toBe(true);
  });

  it('arrivedNow creates a checked_in booking with a check-in time', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const now = new Date('2030-01-07T09:05:00Z');
    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.booking.status).toBe('checked_in');
      expect(res.booking.checkinAt).toBe(now.toISOString());
      const dbRes = await testPool.query('SELECT status, checkin_at FROM bookings WHERE id = $1', [res.booking.id]);
      expect(dbRes.rows[0].status).toBe('checked_in');
      expect(new Date(dbRes.rows[0].checkin_at).toISOString()).toBe(now.toISOString());
    }
  });

  it('arrivedNow is rejected for a future start and writes nothing', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', arrivedNow: true };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('arrived_before_start');

    const count = await testPool.query('SELECT count(*) FROM bookings WHERE org_id = $1', [orgId]);
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it('a checked_in walk-in blocks the slot', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', arrivedNow: true };
    await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: new Date('2030-01-07T09:10:00Z') });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.code).toBe('slot_conflict');
  });

  it('arrivedNow on a day booking', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '08:00', closeHour: '18:00' });
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 0, 40000);

    const input1: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07', arrivedNow: true };
    const res1 = await createBooking(localAppPool, input1, { now: new Date('2030-01-07T10:00:00Z') });
    expect(res1.ok).toBe(true);
    if (res1.ok) expect(res1.booking.status).toBe('checked_in');

    const input2: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07', arrivedNow: true };
    const res2 = await createBooking(localAppPool, input2, { now: new Date('2030-01-07T06:00:00Z') });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('arrived_before_start');
  });

  it('a walk-in pays the full slot', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 4000, 0);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.booking.priceCents).toBe(4000);
  });

  it('createBooking writes an audit row', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-07T09:05:00Z') });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const logs = await auditRows(orgId, 'booking.create');
      expect(logs.length).toBe(1);
      expect(logs[0].actor_id).toBe(userId);
      expect(logs[0].entity_id).toBe(res.booking.id);
      expect(logs[0].diff.priceCents).toBe(res.booking.priceCents);
    }
  });
});