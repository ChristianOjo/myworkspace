import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocation, createLocationCustom, createResource, setResourceRates, createBlock } from './helpers.js';
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

const NOW = new Date('2030-01-01T00:00:00Z');

describe('pricing', () => {
  it('hourly price is rate times duration', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 5000, 0);

    const input: CreateBookingInput = {
      orgId, userId, resourceId,
      start: '2030-01-07T09:00:00Z',
      end: '2030-01-07T12:00:00Z'
    };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.booking.priceCents).toBe(15000);
      expect(res.booking.pricing).toBe('hourly');
      const dbRes = await testPool.query('SELECT price_cents, pricing_type FROM bookings WHERE id = $1', [res.booking.id]);
      expect(dbRes.rows[0].price_cents).toBe(15000);
      expect(dbRes.rows[0].pricing_type).toBe('hourly');
    }
  });

  it('15-minute slots are priced proportionally and rounded to whole cents', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    
    const res1Id = await createResource(orgId, locationId);
    await setResourceRates(res1Id, 1000, 0);
    const input1: CreateBookingInput = { orgId, userId, resourceId: res1Id, start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:15:00Z' };
    const resBooking1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(resBooking1.ok).toBe(true);
    if (resBooking1.ok) expect(resBooking1.booking.priceCents).toBe(250);

    const res2Id = await createResource(orgId, locationId);
    await setResourceRates(res2Id, 3333, 0);
    const input2: CreateBookingInput = { orgId, userId, resourceId: res2Id, start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:15:00Z' };
    const resBooking2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(resBooking2.ok).toBe(true);
    if (resBooking2.ok) expect(resBooking2.booking.priceCents).toBe(833);

    const res3Id = await createResource(orgId, locationId);
    await setResourceRates(res3Id, 3335, 0);
    const input3: CreateBookingInput = { orgId, userId, resourceId: res3Id, start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:15:00Z' };
    const resBooking3 = await createBooking(localAppPool, input3, { now: NOW });
    expect(resBooking3.ok).toBe(true);
    if (resBooking3.ok) expect(resBooking3.booking.priceCents).toBe(834);
  });

  it('a zero rate gives a zero price', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 0, 0);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.booking.priceCents).toBe(0);
  });

  it('a day booking spans opening to closing in the location timezone and costs the day rate', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'America/New_York', openHour: '08:00', closeHour: '18:00' });
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 0, 40000);

    const input1: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(res1.booking.start).toBe('2030-01-07T13:00:00.000Z');
      expect(res1.booking.end).toBe('2030-01-07T23:00:00.000Z');
      expect(res1.booking.priceCents).toBe(40000);
      expect(res1.booking.pricing).toBe('day');
    }

    const input2: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-07-08' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.booking.start).toBe('2030-07-08T12:00:00.000Z');
      expect(res2.booking.end).toBe('2030-07-08T22:00:00.000Z');
    }
  });

  it('a day booking is rejected when the resource has no day rate', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 5000, 0);

    const input: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.http).toBe(422);
      expect(res.code).toBe('policy_violation');
      expect(res.reason).toBe('day_booking_not_offered');
    }
  });

  it('a day booking blocks the whole day and is blocked by any active booking', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '08:00', closeHour: '18:00' });
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 5000, 40000);

    const inputHourly: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T14:00:00Z', end: '2030-01-07T15:00:00Z' };
    await createBooking(localAppPool, inputHourly, { now: NOW });

    const inputDay: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07' };
    const resDay = await createBooking(localAppPool, inputDay, { now: NOW });
    expect(resDay.ok).toBe(false);
    if (!resDay.ok) {
      expect(resDay.http).toBe(409);
      expect(resDay.code).toBe('slot_conflict');
    }

    const resourceId2 = await createResource(orgId, locationId);
    await setResourceRates(resourceId2, 5000, 40000);
    const inputDay2: CreateBookingInput = { orgId, userId, resourceId: resourceId2, kind: 'day', date: '2030-01-07' };
    await createBooking(localAppPool, inputDay2, { now: NOW });

    const inputHourly2: CreateBookingInput = { orgId, userId, resourceId: resourceId2, start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' };
    const resHourly2 = await createBooking(localAppPool, inputHourly2, { now: NOW });
    expect(resHourly2.ok).toBe(false);
    if (!resHourly2.ok) {
      expect(resHourly2.http).toBe(409);
      expect(resHourly2.code).toBe('slot_conflict');
    }
  });

  it('a day booking is rejected only when the day has already ended', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '08:00', closeHour: '18:00' });
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 0, 40000);

    const input: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07' };
    
    const res1 = await createBooking(localAppPool, input, { now: new Date('2030-01-07T21:00:00Z') });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.http).toBe(422);
      expect(res1.code).toBe('policy_violation');
      expect(res1.reason).toBe('in_the_past');
    }

    const res2 = await createBooking(localAppPool, input, { now: new Date('2030-01-07T10:00:00Z') });
    expect(res2.ok).toBe(true);
  });

  it('invalid day and kind inputs are rejected', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-13-45' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('invalid_time');

    const input2: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-02-30' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('invalid_time');

    const input3: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: 'tomorrow' };
    const res3 = await createBooking(localAppPool, input3, { now: NOW });
    expect(res3.ok).toBe(false);
    if (!res3.ok) expect(res3.reason).toBe('invalid_time');

    const input4: CreateBookingInput = { orgId, userId, resourceId, kind: 'weekly' as any, date: '2030-01-07' };
    const res4 = await createBooking(localAppPool, input4, { now: NOW });
    expect(res4.ok).toBe(false);
    if (!res4.ok) expect(res4.reason).toBe('invalid_kind');

    const input5: CreateBookingInput = { orgId, userId, resourceId, kind: 'hourly', date: '2030-01-07' };
    const res5 = await createBooking(localAppPool, input5, { now: NOW });
    expect(res5.ok).toBe(false);
    if (!res5.ok) expect(res5.reason).toBe('invalid_time');
  });

  it('a day booking is rejected when the day has a maintenance block', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '08:00', closeHour: '18:00' });
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 0, 40000);

    await createBlock(orgId, resourceId, '2030-01-07T12:00:00Z', '2030-01-07T13:00:00Z');

    const input: CreateBookingInput = { orgId, userId, resourceId, kind: 'day', date: '2030-01-07' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.http).toBe(422);
      expect(res.code).toBe('policy_violation');
      expect(res.reason).toBe('maintenance_block');
    }
  });

  it('customer details are trimmed, saved and validated', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { 
      orgId, userId, resourceId, 
      start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z',
      customerName: '  Ana Dlamini  ',
      customerPhone: ' 555-0101 '
    };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(res1.booking.customerName).toBe('Ana Dlamini');
      expect(res1.booking.customerPhone).toBe('555-0101');
      const dbRes = await testPool.query('SELECT customer_name, customer_phone FROM bookings WHERE id = $1', [res1.booking.id]);
      expect(dbRes.rows[0].customer_name).toBe('Ana Dlamini');
      expect(dbRes.rows[0].customer_phone).toBe('555-0101');
    }

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: '   ' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('invalid_customer');

    const input3: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'a'.repeat(201) };
    const res3 = await createBooking(localAppPool, input3, { now: NOW });
    expect(res3.ok).toBe(false);
    if (!res3.ok) expect(res3.reason).toBe('invalid_customer');

    const input4: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerPhone: 'a'.repeat(51) };
    const res4 = await createBooking(localAppPool, input4, { now: NOW });
    expect(res4.ok).toBe(false);
    if (!res4.ok) expect(res4.reason).toBe('invalid_customer');

    const resourceId5 = await createResource(orgId, locationId);
    const input5: CreateBookingInput = { orgId, userId, resourceId: resourceId5, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res5 = await createBooking(localAppPool, input5, { now: NOW });
    expect(res5).toMatchObject({ ok: true });
    if (res5.ok) {
      expect(res5.booking.customerName).toBeNull();
      expect(res5.booking.customerPhone).toBeNull();
    }
  });

  it('a booking\'s price does not change when the resource rate changes later', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    await setResourceRates(resourceId, 5000, 0);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      await setResourceRates(resourceId, 9000, 0);
      const dbRes = await testPool.query('SELECT price_cents FROM bookings WHERE id = $1', [res.booking.id]);
      expect(dbRes.rows[0].price_cents).toBe(5000);
    }
  });
});