// test/blocks-api.test.ts
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { testPool, appPool, createLocationCustom, createResource, setResourceRates, loginAs, createStaffUser, auditRows } from './helpers.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';
import { buildApp } from '../src/http/app.js';

let clock = new Date('2030-01-07T08:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeAll(() => {
  process.env.SCRYPT_N = '1024';
});

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
  clock = new Date('2030-01-07T08:00:00Z');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('blocks-api', () => {
  it('a manager can block a window and overlapping bookings are rejected', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    const adminToken = await loginAs(app, 'org-a', 'a@a.a', password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const blockRes = await app.inject({
      method: 'POST', url: `/api/v1/resources/${resId}/blocks`,
      headers: { Authorization: `Bearer ${managerToken}` },
      payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T12:00:00Z', reason: 'Maintenance' }
    });
    expect(blockRes.statusCode).toBe(201);

    const book1 = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { resourceId: resId, start: '2030-01-07T11:00:00Z', end: '2030-01-07T12:00:00Z', customerName: 'J' }
    });
    expect(book1.statusCode).toBe(422); expect(book1.json().error.reason).toBe('maintenance_block');

    const book2 = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { resourceId: resId, start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z', customerName: 'J' }
    });
    expect(book2.statusCode).toBe(201);
  });

  it('a block cannot be created over an active booking', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    const adminToken = await loginAs(app, 'org-a', 'a@a.a', password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const book1 = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { resourceId: resId, start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'J' }
    });
    expect(book1.statusCode).toBe(201);
    const bookingId = book1.json().booking.id;

    const blockRes = await app.inject({
      method: 'POST', url: `/api/v1/resources/${resId}/blocks`,
      headers: { Authorization: `Bearer ${managerToken}` },
      payload: { start: '2030-01-07T10:30:00Z', end: '2030-01-07T11:30:00Z' }
    });
    expect(blockRes.statusCode).toBe(409); expect(blockRes.json().error.reason).toBe('overlaps_bookings');

    await testPool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);

    const blockRes2 = await app.inject({
      method: 'POST', url: `/api/v1/resources/${resId}/blocks`,
      headers: { Authorization: `Bearer ${managerToken}` },
      payload: { start: '2030-01-07T10:30:00Z', end: '2030-01-07T11:30:00Z' }
    });
    expect(blockRes2.statusCode).toBe(201);
  });

  it('overlapping blocks are rejected and adjacent ones are fine', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);

    const block1 = await app.inject({
      method: 'POST', url: `/api/v1/resources/${resId}/blocks`,
      headers: { Authorization: `Bearer ${managerToken}` },
      payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T12:00:00Z' }
    });
    expect(block1.statusCode).toBe(201);

    const block2 = await app.inject({
      method: 'POST', url: `/api/v1/resources/${resId}/blocks`,
      headers: { Authorization: `Bearer ${managerToken}` },
      payload: { start: '2030-01-07T11:00:00Z', end: '2030-01-07T13:00:00Z' }
    });
    expect(block2.statusCode).toBe(409); expect(block2.json().error.reason).toBe('overlapping_block');

    const block3 = await app.inject({
      method: 'POST', url: `/api/v1/resources/${resId}/blocks`,
      headers: { Authorization: `Bearer ${managerToken}` },
      payload: { start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z' }
    });
    expect(block3.statusCode).toBe(201);
  });

  it('block input is validated', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);

    const r1 = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T10:00:00Z' } });
    expect(r1.statusCode).toBe(400); expect(r1.json().error.reason).toBe('invalid_range');

    const r2 = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T11:00:00Z', end: '2030-01-07T10:00:00Z' } });
    expect(r2.statusCode).toBe(400); expect(r2.json().error.reason).toBe('invalid_range');

    const r3 = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T09:10:00Z', end: '2030-01-07T10:00:00Z' } });
    expect(r3.statusCode).toBe(400); expect(r3.json().error.reason).toBe('not_on_slot_boundary');

    const r4 = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00', end: '2030-01-07T11:00:00Z' } });
    expect(r4.statusCode).toBe(400); expect(r4.json().error.reason).toBe('invalid_time');

    clock = new Date('2030-01-07T12:00:00Z');
    const r5 = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' } });
    expect(r5.statusCode).toBe(422); expect(r5.json().error.reason).toBe('in_the_past');
    clock = new Date('2030-01-07T08:00:00Z');

    const r6 = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', reason: 'a'.repeat(501) } });
    expect(r6.statusCode).toBe(400); expect(r6.json().error.reason).toBe('invalid_reason');
  });

  it('members cannot create or delete blocks', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const member = await createStaffUser(orgId, 'member');
    const memberToken = await loginAs(app, 'org-a', member.email, member.password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);

    const cRes = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${memberToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' } });
    expect(cRes.statusCode).toBe(403); expect(cRes.json().error.reason).toBe('manager_required');

    const dRes = await app.inject({ method: 'DELETE', url: `/api/v1/blocks/00000000-0000-0000-0000-000000000000`, headers: { Authorization: `Bearer ${memberToken}` } });
    expect(dRes.statusCode).toBe(403); expect(dRes.json().error.reason).toBe('manager_required');
  });

  it('a manager can delete a block and the slot is bookable again', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    const adminToken = await loginAs(app, 'org-a', 'a@a.a', password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const blockRes = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' } });
    const blockId = blockRes.json().block.id;

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/blocks/${blockId}`, headers: { Authorization: `Bearer ${managerToken}` } });
    expect(delRes.statusCode).toBe(204);

    const bookRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${adminToken}` }, payload: { resourceId: resId, start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'J' } });
    expect(bookRes.statusCode).toBe(201);

    const logs = await auditRows(orgId, 'block.delete');
    expect(logs.length).toBe(1);
  });

  it('blocks list in order and other orgs are hidden', async () => {
    const { orgId: orgA, password: passA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB, password: passB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'org-b', adminEmail: 'b@b.b', adminName: 'B' });
    const managerA = await createStaffUser(orgA, 'location_manager');
    const managerAToken = await loginAs(app, 'org-a', managerA.email, managerA.password);
    const adminAToken = await loginAs(app, 'org-a', 'a@a.a', passA);
    
    const locA = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgA])).rows[0].id;
    const resA = await createResource(orgA, locA);
    const locB = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgB])).rows[0].id;
    const resB = await createResource(orgB, locB);

    await app.inject({ method: 'POST', url: `/api/v1/resources/${resA}/blocks`, headers: { Authorization: `Bearer ${managerAToken}` }, payload: { start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z', reason: 'B' } });
    await app.inject({ method: 'POST', url: `/api/v1/resources/${resA}/blocks`, headers: { Authorization: `Bearer ${managerAToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', reason: 'A' } });
    
    clock = new Date('2030-01-07T07:00:00Z');
    await app.inject({ method: 'POST', url: `/api/v1/resources/${resA}/blocks`, headers: { Authorization: `Bearer ${managerAToken}` }, payload: { start: '2030-01-07T07:00:00Z', end: '2030-01-07T08:00:00Z', reason: 'Past' } });
    clock = new Date('2030-01-07T08:00:00Z');

    const listRes = await app.inject({ method: 'GET', url: `/api/v1/resources/${resA}/blocks`, headers: { Authorization: `Bearer ${adminAToken}` } });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().blocks.length).toBe(2);
    expect(listRes.json().blocks[0].reason).toBe('A');
    expect(listRes.json().blocks[1].reason).toBe('B');

    const otherOrgRes = await app.inject({ method: 'GET', url: `/api/v1/resources/${resB}/blocks`, headers: { Authorization: `Bearer ${adminAToken}` } });
    expect(otherOrgRes.statusCode).toBe(404); expect(otherOrgRes.json().error.message).toBe('Resource not found');

    const randRes = await app.inject({ method: 'GET', url: `/api/v1/resources/00000000-0000-0000-0000-000000000000/blocks`, headers: { Authorization: `Bearer ${adminAToken}` } });
    expect(randRes.statusCode).toBe(404); expect(randRes.json().error.message).toBe('Resource not found');
  });

  it('a block and a booking racing for the same slot never both succeed', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    const adminToken = await loginAs(app, 'org-a', 'a@a.a', password);
    
    for (let i = 0; i < 5; i++) {
      const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
      const resId = await createResource(orgId, locId);
      await setResourceRates(resId, 5000, 40000);

      const [blockRes, bookRes] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' } }),
        app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${adminToken}` }, payload: { resourceId: resId, start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'J' } })
      ]);

      const blockOk = blockRes.statusCode === 201;
      const bookOk = bookRes.statusCode === 201;
      expect(blockOk && bookOk).toBe(false);

      if (!blockOk) expect(blockRes.statusCode).toBe(409);
      if (!bookOk) expect(bookRes.statusCode).toBe(422);

      const overlap = await testPool.query(`
        SELECT 1 FROM bookings b 
        JOIN resource_blocks rb ON b.resource_id = rb.resource_id AND b.period && rb.period 
        WHERE b.resource_id = $1 AND b.status IN ('pending_payment', 'confirmed', 'checked_in')
      `, [resId]);
      expect(overlap.rows.length).toBe(0);
    }
  });

  it('deleting an unknown or another org\'s block returns identical 404s', async () => {
    const { orgId: orgA, password: passA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB, password: passB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'org-b', adminEmail: 'b@b.b', adminName: 'B' });
    const managerA = await createStaffUser(orgA, 'location_manager');
    const managerAToken = await loginAs(app, 'org-a', managerA.email, managerA.password);
    const managerB = await createStaffUser(orgB, 'location_manager');
    const managerBToken = await loginAs(app, 'org-b', managerB.email, managerB.password);
    
    const locB = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgB])).rows[0].id;
    const resB = await createResource(orgB, locB);
    const blockB = await app.inject({ method: 'POST', url: `/api/v1/resources/${resB}/blocks`, headers: { Authorization: `Bearer ${managerBToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' } });
    const blockBId = blockB.json().block.id;

    const delOther = await app.inject({ method: 'DELETE', url: `/api/v1/blocks/${blockBId}`, headers: { Authorization: `Bearer ${managerAToken}` } });
    expect(delOther.statusCode).toBe(404); expect(delOther.json()).toEqual({ error: { code: 'not_found', message: 'Block not found' } });

    const delRand = await app.inject({ method: 'DELETE', url: `/api/v1/blocks/00000000-0000-0000-0000-000000000000`, headers: { Authorization: `Bearer ${managerAToken}` } });
    expect(delRand.statusCode).toBe(404); expect(delRand.json()).toEqual({ error: { code: 'not_found', message: 'Block not found' } });

    const dbCheck = await testPool.query('SELECT id FROM resource_blocks WHERE id = $1', [blockBId]);
    expect(dbCheck.rows.length).toBe(1);
  });

  it('every block change writes an audit row', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);
    
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    const resId = await createResource(orgId, locId);

    const blockRes = await app.inject({ method: 'POST', url: `/api/v1/resources/${resId}/blocks`, headers: { Authorization: `Bearer ${managerToken}` }, payload: { start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' } });
    const blockId = blockRes.json().block.id;

    await app.inject({ method: 'DELETE', url: `/api/v1/blocks/${blockId}`, headers: { Authorization: `Bearer ${managerToken}` } });

    const logs = await auditRows(orgId);
    expect(logs.some((l: any) => l.action === 'block.create' && l.actor_id === manager.id && l.diff.resourceId === resId)).toBe(true);
    expect(logs.some((l: any) => l.action === 'block.delete' && l.actor_id === manager.id && l.diff.resourceId === resId)).toBe(true);
  });
});