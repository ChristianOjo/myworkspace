// myworkspace/test/booking-constraint.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, createOrg, createUser, createLocation, createResource, insertBooking } from './helpers.js';
import { migrate } from '../src/db/migrate.js';
import { Pool } from 'pg';

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await testPool.end();
});

describe('booking-constraint', () => {
  it('20 concurrent identical bookings: exactly one succeeds', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);
    
    const start = '2024-01-01T09:00:00Z';
    const end = '2024-01-01T12:00:00Z';

    const promises = [];
    for (let i = 0; i < 20; i++) {
      const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test', max: 1 });
      promises.push(
        p.query(
          `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
           VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 'confirmed') RETURNING id`,
          [orgId, userId, resourceId, start, end]
        ).finally(() => p.end())
      );
    }

    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected') as any[];

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(19);
    
    for (const r of rejected) {
      const code = r.reason.code;
      expect(code === '23P01' || code === '40P01').toBe(true);
      if (code === '23P01') {
        expect(r.reason.constraint).toBe('bookings_no_overlap');
      }
    }
  });

  it('concurrent overlapping ranges never produce an overlap', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const promises = [];
    for (let i = 0; i < 24; i++) {
      const startHour = 8 + Math.floor(i / 2);
      const start = `2024-01-01T${startHour.toString().padStart(2, '0')}:00:00Z`;
      const end = `2024-01-01T${(startHour + 3).toString().padStart(2, '0')}:00:00Z`;
      
      const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test', max: 1 });
      promises.push(
        p.query(
          `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
           VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 'confirmed') RETURNING id`,
          [orgId, userId, resourceId, start, end]
        ).catch(e => e).finally(() => p.end())
      );
    }

    const results = await Promise.all(promises);
    const successCount = results.filter((r: any) => r && r.rows).length;
    expect(successCount).toBeGreaterThanOrEqual(1);

    const overlapCheck = await testPool.query(`
      SELECT a.id, b.id FROM bookings a 
      JOIN bookings b ON a.resource_id=b.resource_id AND a.id<b.id AND a.period && b.period 
      WHERE a.status IN ('pending_payment','confirmed','checked_in') 
      AND b.status IN ('pending_payment','confirmed','checked_in')
    `);
    expect(overlapCheck.rows.length).toBe(0);
  });

  it('pending_payment, confirmed and checked_in each block an overlapping booking', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);

    for (const status of ['pending_payment', 'confirmed', 'checked_in']) {
      const resourceId = await createResource(orgId, locationId);
      await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status });
      
      try {
        await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T10:00:00Z', end: '2024-01-01T11:00:00Z', status: 'confirmed' });
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.code).toBe('23P01');
        expect(err.constraint).toBe('bookings_no_overlap');
      }
    }
  });

  it('draft, completed, cancelled, no_show and expired do not block', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);

    for (const status of ['draft', 'completed', 'cancelled', 'no_show', 'expired']) {
      const resourceId = await createResource(orgId, locationId);
      await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status });
      
      const newBookingId = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T10:00:00Z', end: '2024-01-01T11:00:00Z', status: 'confirmed' });
      expect(newBookingId).toBeDefined();
    }
  });

  it('cancelling a booking frees the slot immediately', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const bookingId = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status: 'confirmed' });
    await testPool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);

    const newBookingId = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T10:00:00Z', end: '2024-01-01T11:00:00Z', status: 'confirmed' });
    expect(newBookingId).toBeDefined();
  });

  it('re-activating a cancelled booking fails if the slot was taken', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const bookingA = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status: 'confirmed' });
    await testPool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingA]);

    const bookingB = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T10:00:00Z', end: '2024-01-01T11:00:00Z', status: 'confirmed' });
    
    try {
      await testPool.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bookingA]);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23P01');
      expect(err.constraint).toBe('bookings_no_overlap');
    }
  });

  it('adjacent bookings 09:00-12:00 and 12:00-15:00 do not conflict', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    const b1 = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status: 'confirmed' });
    const b2 = await insertBooking({ orgId, userId, resourceId, start: '2024-01-01T12:00:00Z', end: '2024-01-01T15:00:00Z', status: 'confirmed' });
    
    expect(b1).toBeDefined();
    expect(b2).toBeDefined();
  });

  it('same time on different resources does not conflict', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId1 = await createResource(orgId, locationId);
    const resourceId2 = await createResource(orgId, locationId);

    const b1 = await insertBooking({ orgId, userId, resourceId: resourceId1, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status: 'confirmed' });
    const b2 = await insertBooking({ orgId, userId, resourceId: resourceId2, start: '2024-01-01T09:00:00Z', end: '2024-01-01T12:00:00Z', status: 'confirmed' });
    
    expect(b1).toBeDefined();
    expect(b2).toBeDefined();
  });

  it('empty period is rejected', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    try {
      await testPool.query(
        `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
         VALUES ($1, $2, $3, tstzrange($4, $4, '[)'), 'confirmed')`,
        [orgId, userId, resourceId, '2024-01-01T09:00:00Z']
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23514');
    }
  });

  it('unbounded period is rejected', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    try {
      await testPool.query(
        `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
         VALUES ($1, $2, $3, tstzrange($4, NULL, '[)'), 'confirmed')`,
        [orgId, userId, resourceId, '2024-01-01T09:00:00Z']
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23514');
    }
  });

  it('inclusive upper bound is rejected', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId);
    const locationId = await createLocation(orgId);
    const resourceId = await createResource(orgId, locationId);

    try {
      await testPool.query(
        `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
         VALUES ($1, $2, $3, tstzrange($4, $5, '[]'), 'confirmed')`,
        [orgId, userId, resourceId, '2024-01-01T09:00:00Z', '2024-01-01T12:00:00Z']
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23514');
    }
  });

  it('booking cannot reference a resource from another org', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const userId = await createUser(orgA);
    const locationId = await createLocation(orgB);
    const resourceId = await createResource(orgB, locationId);

    try {
      await testPool.query(
        `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
         VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 'confirmed')`,
        [orgA, userId, resourceId, '2024-01-01T09:00:00Z', '2024-01-01T12:00:00Z']
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23503');
    }
  });

  it('booking cannot reference a user from another org', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const userId = await createUser(orgB);
    const locationId = await createLocation(orgA);
    const resourceId = await createResource(orgA, locationId);

    try {
      await testPool.query(
        `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
         VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 'confirmed')`,
        [orgA, userId, resourceId, '2024-01-01T09:00:00Z', '2024-01-01T12:00:00Z']
      );
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23503');
    }
  });

  it('emails are case-insensitive unique within an org', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();

    await createUser(orgA, 'Ana@x.com');
    
    try {
      await createUser(orgA, 'ana@x.com');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('23505');
    }

    const userIdB = await createUser(orgB, 'ana@x.com');
    expect(userIdB).toBeDefined();
  });

  it('running migrate twice applies nothing the second time', async () => {
    const applied = await migrate(testPool);
    expect(applied.length).toBe(0);
  });
});