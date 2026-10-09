// test/tenant-isolation.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testPool, appPool, seedTwoOrgs } from './helpers.js';
import { withOrg, resolveOrgId } from '../src/db/withOrg.js';
import { createAppPool } from '../src/db/pool.js';

let seed: Awaited<ReturnType<typeof seedTwoOrgs>>;

beforeAll(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
  seed = await seedTwoOrgs();
});

afterAll(async () => {
  await appPool.end();
});

describe('tenant-isolation', () => {
  it('app_user is not a superuser, cannot bypass RLS, and owns no tables', async () => {
    const roleRes = await appPool.query(`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'
    `);
    expect(roleRes.rows[0].rolsuper).toBe(false);
    expect(roleRes.rows[0].rolbypassrls).toBe(false);

    const tablesRes = await appPool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'app_user'
    `);
    expect(tablesRes.rows.length).toBe(0);
  });

  it('no org context returns zero rows on every table', async () => {
    const orgs = await appPool.query('SELECT count(*) FROM organizations');
    const users = await appPool.query('SELECT count(*) FROM users');
    const locs = await appPool.query('SELECT count(*) FROM locations');
    const res = await appPool.query('SELECT count(*) FROM resources');
    const books = await appPool.query('SELECT count(*) FROM bookings');

    expect(Number(orgs.rows[0].count)).toBe(0);
    expect(Number(users.rows[0].count)).toBe(0);
    expect(Number(locs.rows[0].count)).toBe(0);
    expect(Number(res.rows[0].count)).toBe(0);
    expect(Number(books.rows[0].count)).toBe(0);
  });

  it('org A context sees only org A rows on every table', async () => {
    await withOrg(appPool, seed.A.orgId, async (client) => {
      const orgs = await client.query('SELECT count(*) FROM organizations');
      const users = await client.query('SELECT count(*) FROM users');
      const locs = await client.query('SELECT count(*) FROM locations');
      const res = await client.query('SELECT count(*) FROM resources');
      const books = await client.query('SELECT count(*) FROM bookings');

      expect(Number(orgs.rows[0].count)).toBe(1);
      expect(Number(users.rows[0].count)).toBe(2);
      expect(Number(locs.rows[0].count)).toBe(1);
      expect(Number(res.rows[0].count)).toBe(2);
      expect(Number(books.rows[0].count)).toBe(2);

      const booksRes = await client.query('SELECT org_id FROM bookings');
      expect(booksRes.rows.every((r: any) => r.org_id === seed.A.orgId)).toBe(true);
    });

    await withOrg(appPool, seed.B.orgId, async (client) => {
      const orgs = await client.query('SELECT count(*) FROM organizations');
      const users = await client.query('SELECT count(*) FROM users');
      const locs = await client.query('SELECT count(*) FROM locations');
      const res = await client.query('SELECT count(*) FROM resources');
      const books = await client.query('SELECT count(*) FROM bookings');

      expect(Number(orgs.rows[0].count)).toBe(1);
      expect(Number(users.rows[0].count)).toBe(2);
      expect(Number(locs.rows[0].count)).toBe(1);
      expect(Number(res.rows[0].count)).toBe(2);
      expect(Number(books.rows[0].count)).toBe(2);

      const booksRes = await client.query('SELECT org_id FROM bookings');
      expect(booksRes.rows.every((r: any) => r.org_id === seed.B.orgId)).toBe(true);
    });
  });

  it('org A cannot read org B\'s booking by id', async () => {
    await withOrg(appPool, seed.A.orgId, async (client) => {
      const res = await client.query('SELECT id FROM bookings WHERE id = $1', [seed.B.bookingIds[0]]);
      expect(res.rows.length).toBe(0);
    });
  });

  it('org A cannot update or delete org B\'s rows', async () => {
    await withOrg(appPool, seed.A.orgId, async (client) => {
      const updateBook = await client.query(
        `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
        [seed.B.bookingIds[0]]
      );
      expect(updateBook.rowCount).toBe(0);

      const deleteBook = await client.query(
        `DELETE FROM bookings WHERE id = $1`,
        [seed.B.bookingIds[0]]
      );
      expect(deleteBook.rowCount).toBe(0);

      const updateUser = await client.query(
        `UPDATE users SET full_name = 'Hacked' WHERE id = $1`,
        [seed.B.userIds[0]]
      );
      expect(updateUser.rowCount).toBe(0);
    });

    const checkBook = await testPool.query('SELECT status FROM bookings WHERE id = $1', [seed.B.bookingIds[0]]);
    expect(checkBook.rows[0].status).toBe('confirmed');
  });

  it('insert with another org\'s org_id is rejected', async () => {
    await expect(
      withOrg(appPool, seed.A.orgId, async (client) => {
        await client.query(
          `INSERT INTO locations (org_id, name) VALUES ($1, $2)`,
          [seed.B.orgId, 'Bad Location']
        );
      })
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      withOrg(appPool, seed.A.orgId, async (client) => {
        await client.query(
          `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
           VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), 'confirmed')`,
          [seed.B.orgId, seed.B.userIds[0], seed.B.resourceIds[0], '2024-01-01T09:00:00Z', '2024-01-01T12:00:00Z']
        );
      })
    ).rejects.toMatchObject({ code: '42501' });

    const locCount = await testPool.query(
      `SELECT count(*) FROM locations WHERE org_id = $1`,
      [seed.B.orgId]
    );
    expect(Number(locCount.rows[0].count)).toBe(1);

    const bookCount = await testPool.query(
      `SELECT count(*) FROM bookings WHERE org_id = $1`,
      [seed.B.orgId]
    );
    expect(Number(bookCount.rows[0].count)).toBe(2);
  });

  it('insert with own org_id works', async () => {
    try {
      await withOrg(appPool, seed.A.orgId, async (client) => {
        const res = await client.query(
          `INSERT INTO locations (org_id, name) VALUES ($1, $2) RETURNING id`,
          [seed.A.orgId, 'New Location A']
        );
        expect(res.rows[0].id).toBeDefined();
        throw new Error('rollback');
      });
    } catch (err: any) {
      expect(err.message).toBe('rollback');
    }
  });

  it('context does not leak between transactions on the same connection', async () => {
    const singlePool = createAppPool(process.env.TEST_APP_DATABASE_URL ?? 'postgres://app_user:app_user@localhost:5432/myworkspace_test', 1);
    try {
      await withOrg(singlePool, seed.A.orgId, async (client) => {
        const res = await client.query('SELECT count(*) FROM bookings');
        expect(Number(res.rows[0].count)).toBe(2);
      });

      const noContextRes = await singlePool.query('SELECT count(*) FROM bookings');
      expect(Number(noContextRes.rows[0].count)).toBe(0);

      const settingRes = await singlePool.query("SELECT current_setting('app.org_id', true) AS val");
      expect(settingRes.rows[0].val === '' || settingRes.rows[0].val === null).toBe(true);
    } finally {
      await singlePool.end();
    }
  });

  it('withOrg rolls back and clears context on error', async () => {
    const singlePool = createAppPool(process.env.TEST_APP_DATABASE_URL ?? 'postgres://app_user:app_user@localhost:5432/myworkspace_test', 1);
    try {
      let newLocId: string | undefined;
      try {
        await withOrg(singlePool, seed.A.orgId, async (client) => {
          const res = await client.query(
            `INSERT INTO locations (org_id, name) VALUES ($1, $2) RETURNING id`,
            [seed.A.orgId, 'Temp Location']
          );
          newLocId = res.rows[0].id;
          throw new Error('Simulated error');
        });
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toBe('Simulated error');
      }

      if (newLocId) {
        const check = await testPool.query('SELECT id FROM locations WHERE id = $1', [newLocId]);
        expect(check.rows.length).toBe(0);
      }

      const noContextRes = await singlePool.query('SELECT count(*) FROM bookings');
      expect(Number(noContextRes.rows[0].count)).toBe(0);
    } finally {
      await singlePool.end();
    }
  });

  it('withOrg rejects a non-uuid org id', async () => {
    try {
      await withOrg(appPool, "x'; DROP TABLE bookings; --", async () => {
        expect(true).toBe(false);
      });
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('invalid org id');
    }
  });

  it('resolveOrgId finds an org by slug without context', async () => {
    const idA = await resolveOrgId(appPool, seed.A.slug);
    expect(idA).toBe(seed.A.orgId);

    const idUnknown = await resolveOrgId(appPool, 'unknown-slug');
    expect(idUnknown).toBeNull();

    const throwawayOrgId = await testPool.query(
      `INSERT INTO organizations (name, slug, deleted_at) VALUES ($1, $2, now()) RETURNING id`,
      ['Throwaway', 'throwaway-slug']
    ).then(r => r.rows[0].id);

    const idDeleted = await resolveOrgId(appPool, 'throwaway-slug');
    expect(idDeleted).toBeNull();
  });

  it('login flow: slug, then org context, then user by email', async () => {
    const orgId = await resolveOrgId(appPool, seed.A.slug);
    expect(orgId).toBe(seed.A.orgId);

    await withOrg(appPool, orgId!, async (client) => {
      const res = await client.query(`SELECT id, org_id FROM users WHERE email = $1`, ['ANA@X.COM']);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].org_id).toBe(seed.A.orgId);
    });
  });

  it('app_user cannot create organizations or touch schema_migrations', async () => {
    try {
      await appPool.query(`INSERT INTO organizations (name, slug) VALUES ('Bad', 'bad')`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('42501');
    }

    try {
      await appPool.query(`SELECT * FROM schema_migrations`);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('42501');
    }
  });

  it('concurrent withOrg calls for different orgs never see each other\'s rows', async () => {
    const promises = [];
    for (let i = 0; i < 40; i++) {
      const targetOrg = i % 2 === 0 ? seed.A : seed.B;
      promises.push(
        withOrg(appPool, targetOrg.orgId, async (client) => {
          const res = await client.query(`SELECT count(*) as count, array_agg(DISTINCT org_id) as org_ids FROM bookings`);
          return {
            count: Number(res.rows[0].count),
            orgIds: res.rows[0].org_ids.filter((id: string | null) => id !== null)
          };
        })
      );
    }

    const results = await Promise.all(promises);
    for (let i = 0; i < 40; i++) {
      const targetOrg = i % 2 === 0 ? seed.A : seed.B;
      expect(results[i].count).toBe(2);
      expect(results[i].orgIds).toEqual([targetOrg.orgId]);
    }
  });
});