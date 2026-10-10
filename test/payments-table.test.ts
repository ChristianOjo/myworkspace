import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, seedTwoOrgs } from './helpers.js';
import { withOrg } from '../src/db/withOrg.js';
import { createAppPool } from '../src/db/pool.js';

const TEST_APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL || 'postgres://app_user:app_user@localhost:5432/myworkspace_test';
const localAppPool = createAppPool(TEST_APP_DATABASE_URL, 25);

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await localAppPool.end();
});

describe('payments-table', () => {
  it('staff can record a payment and a refund in their own org', async () => {
    const seed = await seedTwoOrgs();
    const bookingId = seed.A.bookingIds[0];
    const userId = seed.A.userIds[0];

    await withOrg(localAppPool, seed.A.orgId, async (client) => {
      await client.query(
        `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
        [seed.A.orgId, bookingId, 5000, 'payment', userId]
      );
      await client.query(
        `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
        [seed.A.orgId, bookingId, -2000, 'refund', userId]
      );

      const sumRes = await client.query(
        `SELECT sum(amount_cents) as total FROM payments WHERE booking_id = $1`,
        [bookingId]
      );
      expect(Number(sumRes.rows[0].total)).toBe(3000);
    });
  });

  it('payments are append-only for the app role', async () => {
    const seed = await seedTwoOrgs();
    const bookingId = seed.A.bookingIds[0];
    const userId = seed.A.userIds[0];

    await withOrg(localAppPool, seed.A.orgId, async (client) => {
      await client.query(
        `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
        [seed.A.orgId, bookingId, 5000, 'payment', userId]
      );
    });

    await expect(
      withOrg(localAppPool, seed.A.orgId, async (client) => {
        await client.query(`UPDATE payments SET amount_cents = 9999 WHERE booking_id = $1`, [bookingId]);
      })
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withOrg(localAppPool, seed.A.orgId, async (client) => {
        await client.query(`DELETE FROM payments WHERE booking_id = $1`, [bookingId]);
      })
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('amount sign must match kind and zero is rejected', async () => {
    const seed = await seedTwoOrgs();
    const bookingId = seed.A.bookingIds[0];
    const userId = seed.A.userIds[0];

    const attempts = [
      { amount: -100, kind: 'payment' },
      { amount: 100, kind: 'refund' },
      { amount: 0, kind: 'payment' },
      { amount: 0, kind: 'refund' },
      { amount: 100, kind: 'tip' }
    ];

    for (const attempt of attempts) {
      await expect(
        withOrg(localAppPool, seed.A.orgId, async (client) => {
          await client.query(
            `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
            [seed.A.orgId, bookingId, attempt.amount, attempt.kind, userId]
          );
        })
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('org A cannot see or insert org B\'s payments', async () => {
    const seed = await seedTwoOrgs();
    const bookingIdB = seed.B.bookingIds[0];
    const userIdB = seed.B.userIds[0];

    await testPool.query(
      `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
      [seed.B.orgId, bookingIdB, 5000, 'payment', userIdB]
    );

    await withOrg(localAppPool, seed.A.orgId, async (client) => {
      const countRes = await client.query(`SELECT count(*) FROM payments WHERE booking_id = $1`, [bookingIdB]);
      expect(Number(countRes.rows[0].count)).toBe(0);

      await expect(
        client.query(
          `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
          [seed.B.orgId, bookingIdB, 5000, 'payment', userIdB]
        )
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('a payment cannot reference a booking or staff member from another org', async () => {
    const seed = await seedTwoOrgs();
    const bookingIdB = seed.B.bookingIds[0];
    const userIdB = seed.B.userIds[0];

    await expect(
      withOrg(localAppPool, seed.A.orgId, async (client) => {
        await client.query(
          `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
          [seed.A.orgId, bookingIdB, 5000, 'payment', seed.A.userIds[0]]
        );
      })
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      withOrg(localAppPool, seed.A.orgId, async (client) => {
        await client.query(
          `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
          [seed.A.orgId, seed.A.bookingIds[0], 5000, 'payment', userIdB]
        );
      })
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('no org context returns zero payment rows', async () => {
    const seed = await seedTwoOrgs();
    const bookingId = seed.A.bookingIds[0];
    const userId = seed.A.userIds[0];

    await testPool.query(
      `INSERT INTO payments (org_id, booking_id, amount_cents, kind, received_by) VALUES ($1, $2, $3, $4, $5)`,
      [seed.A.orgId, bookingId, 5000, 'payment', userId]
    );

    const countRes = await localAppPool.query(`SELECT count(*) FROM payments`);
    expect(Number(countRes.rows[0].count)).toBe(0);
  });
});