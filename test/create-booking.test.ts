import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocation, createLocationCustom, createResource, setResourceStatus, deactivateUser, createBlock } from './helpers.js';
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

describe('create-booking', () => {
  it('creates a confirmed booking', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = {
      orgId, userId, resourceId,
      start: '2030-01-07T09:00:00Z',
      end: '2030-01-07T12:00:00Z'
    };

    const result = await createBooking(localAppPool, input, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.booking.status).toBe('confirmed');
      expect(result.booking.start).toBe('2030-01-07T09:00:00.000Z');
      expect(result.booking.end).toBe('2030-01-07T12:00:00.000Z');

      const dbRes = await testPool.query('SELECT id FROM bookings WHERE id = $1', [result.booking.id]);
      expect(dbRes.rows.length).toBe(1);
    }
  });

  it('rejects start not before end', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.http).toBe(400);
      expect(res1.code).toBe('validation_error');
      expect(res1.reason).toBe('invalid_range');
    }

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T10:00:00Z', end: '2030-01-07T09:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.http).toBe(400);
      expect(res2.code).toBe('validation_error');
      expect(res2.reason).toBe('invalid_range');
    }
  });

  it('rejects times not on 15-minute boundaries', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:10:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.http).toBe(400);
      expect(res.code).toBe('validation_error');
      expect(res.reason).toBe('not_on_slot_boundary');
    }
  });

  it('rejects timestamps without a timezone or unparsable values', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00', end: '2030-01-07T10:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('invalid_time');

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: 'not-a-date', end: '2030-01-07T10:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('invalid_time');

    const input3: CreateBookingInput = { orgId, userId, resourceId: 'not-a-uuid', start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res3 = await createBooking(localAppPool, input3, { now: NOW });
    expect(res3.ok).toBe(false);
    if (!res3.ok) expect(res3.reason).toBe('invalid_id');
  });

  it('rejects a start in the past', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2029-01-01T09:00:00Z', end: '2029-01-01T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: new Date('2030-01-01T00:00:00Z') });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.http).toBe(422);
      expect(res.code).toBe('policy_violation');
      expect(res.reason).toBe('in_the_past');
    }
  });

  it('rejects bookings outside opening hours', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T07:45:00Z', end: '2030-01-07T09:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('outside_hours');

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T19:00:00Z', end: '2030-01-07T20:15:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.reason).toBe('outside_hours');

    const input3: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T08:00:00Z', end: '2030-01-07T20:00:00Z' };
    const res3 = await createBooking(localAppPool, input3, { now: NOW });
    expect(res3.ok).toBe(true);
  });

  it('the same UTC time is allowed or rejected depending on daylight saving', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'America/New_York', openHour: '08:00', closeHour: '18:00' });
    const resourceId = await createResource(orgId, locationId);

    const input1: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('outside_hours');

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-07-08T12:00:00Z', end: '2030-07-08T13:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(true);
  });

  it('rejects a booking that spans two local days', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '00:00', closeHour: '23:59' });
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T23:00:00Z', end: '2030-01-08T01:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.http).toBe(422);
      expect(res.code).toBe('policy_violation');
      expect(res.reason).toBe('outside_hours');
    }
  });

  it('rejects overlap with a maintenance block, allows adjacent', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    await createBlock(orgId, resourceId, '2030-01-07T10:00:00Z', '2030-01-07T12:00:00Z');

    const input1: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T11:00:00Z', end: '2030-01-07T13:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1.ok).toBe(false);
    if (!res1.ok) expect(res1.reason).toBe('maintenance_block');

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2.ok).toBe(true);
  });

  it('rejects inactive resources', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    
    const res1Id = await createResource(orgId, locationId);
    await setResourceStatus(res1Id, 'maintenance');
    const input1: CreateBookingInput = { orgId, userId, resourceId: res1Id, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const resBooking1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(resBooking1.ok).toBe(false);
    if (!resBooking1.ok) expect(resBooking1.reason).toBe('resource_unavailable');

    const res2Id = await createResource(orgId, locationId);
    await setResourceStatus(res2Id, 'retired');
    const input2: CreateBookingInput = { orgId, userId, resourceId: res2Id, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const resBooking2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(resBooking2.ok).toBe(false);
    if (!resBooking2.ok) expect(resBooking2.reason).toBe('resource_unavailable');
  });

  it('a resource from another org and an unknown resource return identical not_found', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const userId = await createUser(orgA);
    const locationId = await createLocation(orgB);
    const resourceIdB = await createResource(orgB, locationId);
    const unknownResourceId = '00000000-0000-0000-0000-000000000000';

    const input1: CreateBookingInput = { orgId: orgA, userId, resourceId: resourceIdB, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Resource not found' });

    const input2: CreateBookingInput = { orgId: orgA, userId, resourceId: unknownResourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2).toEqual({ ok: false, http: 404, code: 'not_found', message: 'Resource not found' });
  });

  it('a user from another org and an unknown user return identical not_found', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const locationId = await createLocation(orgA);
    const resourceId = await createResource(orgA, locationId);
    const userB = await createUser(orgB);
    const unknownUserId = '00000000-0000-0000-0000-000000000000';

    const input1: CreateBookingInput = { orgId: orgA, userId: userB, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res1 = await createBooking(localAppPool, input1, { now: NOW });
    expect(res1).toEqual({ ok: false, http: 404, code: 'not_found', message: 'User not found' });

    const input2: CreateBookingInput = { orgId: orgA, userId: unknownUserId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res2 = await createBooking(localAppPool, input2, { now: NOW });
    expect(res2).toEqual({ ok: false, http: 404, code: 'not_found', message: 'User not found' });
  });

  it('rejects a deactivated user', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    await deactivateUser(userId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res = await createBooking(localAppPool, input, { now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.http).toBe(422);
      expect(res.code).toBe('policy_violation');
      expect(res.reason).toBe('user_inactive');
    }
  });

  it('a conflicting booking returns slot_conflict', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    
    const res1 = await createBooking(localAppPool, input, { now: NOW });
    expect(res1.ok).toBe(true);

    const res2 = await createBooking(localAppPool, input, { now: NOW });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.http).toBe(409);
      expect(res2.code).toBe('slot_conflict');
      expect(res2.reason).toBe('slot_taken');
    }
  });

  it('20 concurrent identical requests: exactly one ok, nineteen slot_conflict, none thrown', async () => {
    const orgId = await createOrg();
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    
    const userIds = await Promise.all(Array.from({ length: 20 }).map(() => createUser(orgId)));

    const promises = userIds.map(userId => {
      const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
      return createBooking(localAppPool, input, { now: NOW });
    });

    const results = await Promise.allSettled(promises);
    
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    
    const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const okCount = fulfilled.filter(r => r.value.ok === true).length;
    const conflictCount = fulfilled.filter(r => r.value.ok === false && r.value.http === 409 && r.value.code === 'slot_conflict').length;

    expect(okCount).toBe(1);
    expect(conflictCount).toBe(19);
  });

  it('24 concurrent overlapping requests never overlap', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocationCustom(orgId, { timezone: 'UTC', openHour: '00:00', closeHour: '23:59' });
    const resourceId = await createResource(orgId, locationId);

    const promises = [];
    for (let i = 0; i < 24; i++) {
      const startMin = 8 * 60 + i * 30;
      const startH = Math.floor(startMin / 60);
      const startM = startMin % 60;
      const start = `2030-01-07T${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00Z`;
      
      const endMin = startMin + 180;
      const endH = Math.floor(endMin / 60);
      const endM = endMin % 60;
      const end = `2030-01-07T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00Z`;

      const input: CreateBookingInput = { orgId, userId, resourceId, start, end };
      promises.push(createBooking(localAppPool, input, { now: NOW }));
    }

    const results = await Promise.allSettled(promises);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);

    const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const okCount = fulfilled.filter(r => r.value.ok === true).length;
    const conflictCount = fulfilled.filter(r => r.value.ok === false && r.value.http === 409).length;
    
    expect(okCount + conflictCount).toBe(24);
    expect(okCount).toBeGreaterThanOrEqual(1);

    const overlapCheck = await testPool.query(`
      SELECT a.id, b.id FROM bookings a 
      JOIN bookings b ON a.resource_id=b.resource_id AND a.id<b.id AND a.period && b.period 
      WHERE a.status IN ('pending_payment','confirmed','checked_in') 
      AND b.status IN ('pending_payment','confirmed','checked_in')
    `);
    expect(overlapCheck.rows.length).toBe(0);
  });

  it('a cancelled booking\'s slot can be booked again', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    const res1 = await createBooking(localAppPool, input, { now: NOW });
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      await testPool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [res1.booking.id]);
      
      const res2 = await createBooking(localAppPool, input, { now: NOW });
      expect(res2.ok).toBe(true);
    }
  });

  it('rejected requests write nothing', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    await createBlock(orgId, resourceId, '2030-01-07T10:00:00Z', '2030-01-07T12:00:00Z');

    const input1: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T11:00:00Z', end: '2030-01-07T13:00:00Z' };
    await createBooking(localAppPool, input1, { now: NOW });

    const input2: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T07:00:00Z', end: '2030-01-07T08:00:00Z' };
    await createBooking(localAppPool, input2, { now: NOW });

    const count = await testPool.query(`SELECT count(*) FROM bookings WHERE org_id = $1`, [orgId]);
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it('unexpected database errors are rethrown, not mapped to 409', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const fakePool: any = {
      connect: async () => { throw new Error('boom'); }
    };

    const input: CreateBookingInput = { orgId, userId, resourceId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' };
    
    await expect(createBooking(fakePool, input, { now: NOW })).rejects.toThrow('boom');
  });
});