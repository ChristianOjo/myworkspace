// test/catalog-api.test.ts
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

describe('catalog-api', () => {
  it('an org_admin can create a location and a resource that can then be booked', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);

    const locRes = await app.inject({
      method: 'POST', url: '/api/v1/locations',
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: 'Loc 1', timezone: 'UTC', openHour: '08:00', closeHour: '20:00' }
    });
    expect(locRes.statusCode).toBe(201);
    const locId = locRes.json().location.id;

    const resRes = await app.inject({
      method: 'POST', url: '/api/v1/resources',
      headers: { Authorization: `Bearer ${token}` },
      payload: { locationId: locId, type: 'desk', name: 'Desk 1', hourlyRateCents: 5000, dayRateCents: 40000 }
    });
    expect(resRes.statusCode).toBe(201);
    const resId = resRes.json().resource.id;

    const bookRes = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'John' }
    });
    expect(bookRes.statusCode).toBe(201);
    expect(bookRes.json().booking.priceCents).toBe(10000);
  });

  it('only org_admin can create or change locations and resources', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const member = await createStaffUser(orgId, 'member');
    const manager = await createStaffUser(orgId, 'location_manager');
    const memberToken = await loginAs(app, 'org-a', member.email, member.password);
    const managerToken = await loginAs(app, 'org-a', manager.email, manager.password);

    const routes = [
      { method: 'POST', url: '/api/v1/locations', payload: { name: 'L', timezone: 'UTC', openHour: '08:00', closeHour: '20:00' } },
      { method: 'PATCH', url: '/api/v1/locations/00000000-0000-0000-0000-000000000000', payload: { name: 'L' } },
      { method: 'POST', url: '/api/v1/resources', payload: { locationId: '00000000-0000-0000-0000-000000000000', type: 'desk', name: 'R', hourlyRateCents: 0, dayRateCents: 0 } },
      { method: 'PATCH', url: '/api/v1/resources/00000000-0000-0000-0000-000000000000', payload: { name: 'R' } }
    ];

    for (const r of routes) {
      const resM = await app.inject({ method: r.method as any, url: r.url, headers: { Authorization: `Bearer ${memberToken}` }, payload: r.payload });
      expect(resM.statusCode).toBe(403);
      expect(resM.json().error.reason).toBe('admin_required');

      const resMgr = await app.inject({ method: r.method as any, url: r.url, headers: { Authorization: `Bearer ${managerToken}` }, payload: r.payload });
      expect(resMgr.statusCode).toBe(403);
      expect(resMgr.json().error.reason).toBe('admin_required');
    }
  });

  it('location input is validated', async () => {
    const { password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);

    const tzRes = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'Mars/Base', openHour: '08:00', closeHour: '20:00' } });
    expect(tzRes.statusCode).toBe(400); expect(tzRes.json().error.reason).toBe('invalid_timezone');

    const h1 = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'UTC', openHour: '8:00', closeHour: '20:00' } });
    expect(h1.statusCode).toBe(400); expect(h1.json().error.reason).toBe('invalid_hours');

    const h2 = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'UTC', openHour: '25:00', closeHour: '20:00' } });
    expect(h2.statusCode).toBe(400); expect(h2.json().error.reason).toBe('invalid_hours');

    const h3 = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'UTC', openHour: '08:10', closeHour: '20:00' } });
    expect(h3.statusCode).toBe(400); expect(h3.json().error.reason).toBe('invalid_hours');

    const h4 = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'UTC', openHour: '20:00', closeHour: '08:00' } });
    expect(h4.statusCode).toBe(400); expect(h4.json().error.reason).toBe('invalid_hours');

    const nameRes = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: '', timezone: 'UTC', openHour: '08:00', closeHour: '20:00' } });
    expect(nameRes.statusCode).toBe(400); expect(nameRes.json().error.reason).toBe('invalid_name');

    const extraRes = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'UTC', openHour: '08:00', closeHour: '20:00', extra: 1 } });
    expect(extraRes.statusCode).toBe(400);
  });

  it('resource input is validated', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;

    const typeRes = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'bed', name: 'R', hourlyRateCents: 0, dayRateCents: 0 } });
    expect(typeRes.statusCode).toBe(400); expect(typeRes.json().error.reason).toBe('invalid_type');

    const rateRes = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R', hourlyRateCents: -1, dayRateCents: 0 } });
    expect(rateRes.statusCode).toBe(400); expect(rateRes.json().error.reason).toBe('invalid_rate');

    const cap1 = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R', capacity: 0, hourlyRateCents: 0, dayRateCents: 0 } });
    expect(cap1.statusCode).toBe(400); expect(cap1.json().error.reason).toBe('invalid_capacity');

    const cap2 = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R', capacity: 1001, hourlyRateCents: 0, dayRateCents: 0 } });
    expect(cap2.statusCode).toBe(400); expect(cap2.json().error.reason).toBe('invalid_capacity');

    const floatRes = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R', hourlyRateCents: 10.5, dayRateCents: 0 } });
    expect(floatRes.statusCode).toBe(400);

    const strRes = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R', hourlyRateCents: '100' as any, dayRateCents: 0 } });
    expect(strRes.statusCode).toBe(400);

    const unknownLoc = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: '00000000-0000-0000-0000-000000000000', type: 'desk', name: 'R', hourlyRateCents: 0, dayRateCents: 0 } });
    expect(unknownLoc.statusCode).toBe(404); expect(unknownLoc.json().error.message).toBe('Location not found');

    const { orgId: orgB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'org-b', adminEmail: 'b@b.b', adminName: 'B' });
    const locB = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgB])).rows[0].id;
    const otherLoc = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locB, type: 'desk', name: 'R', hourlyRateCents: 0, dayRateCents: 0 } });
    expect(otherLoc.statusCode).toBe(404); expect(otherLoc.json().error.message).toBe('Location not found');
  });

  it('updating a location changes hours for new bookings only', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    
    const res1Id = await createResource(orgId, locId);
    await setResourceRates(res1Id, 5000, 40000);
    const res2Id = await createResource(orgId, locId);
    await setResourceRates(res2Id, 5000, 40000);

    const book1 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: res1Id, start: '2030-01-07T17:00:00Z', end: '2030-01-07T18:00:00Z', customerName: 'J' } });
    expect(book1.statusCode).toBe(201);

    const patchRes = await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locId}`, headers: { Authorization: `Bearer ${token}` }, payload: { closeHour: '17:00' } });
    expect(patchRes.statusCode).toBe(200);

    const book2 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: res2Id, start: '2030-01-07T17:00:00Z', end: '2030-01-07T18:00:00Z', customerName: 'J' } });
    expect(book2.statusCode).toBe(422); expect(book2.json().error.reason).toBe('outside_hours');

    const noUpdate = await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locId}`, headers: { Authorization: `Bearer ${token}` }, payload: { closeHour: '17:00' } });
    expect(noUpdate.statusCode).toBe(200);
  });

  it('updating rates does not change existing bookings\' prices', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const book1 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'J' } });
    expect(book1.statusCode).toBe(201);
    const bookingId = book1.json().booking.id;

    const patchRes = await app.inject({ method: 'PATCH', url: `/api/v1/resources/${resId}`, headers: { Authorization: `Bearer ${token}` }, payload: { hourlyRateCents: 9000 } });
    expect(patchRes.statusCode).toBe(200);

    const dbRes = await testPool.query('SELECT price_cents FROM bookings WHERE id = $1', [bookingId]);
    expect(dbRes.rows[0].price_cents).toBe(10000);

    const book2 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-07T13:00:00Z', end: '2030-01-07T14:00:00Z', customerName: 'J' } });
    expect(book2.statusCode).toBe(201);
    expect(book2.json().booking.priceCents).toBe(9000);
  });

  it('retiring a resource blocks new bookings, hides it from the default list and reports upcoming bookings', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;
    
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const book1 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-08T10:00:00Z', end: '2030-01-08T11:00:00Z', customerName: 'J' } });
    expect(book1.statusCode).toBe(201);

    const patchRes = await app.inject({ method: 'PATCH', url: `/api/v1/resources/${resId}`, headers: { Authorization: `Bearer ${token}` }, payload: { status: 'retired' } });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().activeFutureBookings).toBe(1);

    const book2 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-08T13:00:00Z', end: '2030-01-08T14:00:00Z', customerName: 'J' } });
    expect(book2.statusCode).toBe(422); expect(book2.json().error.reason).toBe('resource_unavailable');

    const listDefault = await app.inject({ method: 'GET', url: `/api/v1/resources?locationId=${locId}`, headers: { Authorization: `Bearer ${token}` } });
    expect(listDefault.statusCode).toBe(200);
    expect(listDefault.json().resources.find((r: any) => r.id === resId)).toBeUndefined();

    const listAll = await app.inject({ method: 'GET', url: `/api/v1/resources?locationId=${locId}&includeRetired=true`, headers: { Authorization: `Bearer ${token}` } });
    expect(listAll.statusCode).toBe(200);
    expect(listAll.json().resources.find((r: any) => r.id === resId)).toBeDefined();

    const reactivate = await app.inject({ method: 'PATCH', url: `/api/v1/resources/${resId}`, headers: { Authorization: `Bearer ${token}` }, payload: { status: 'active' } });
    expect(reactivate.statusCode).toBe(200);
    expect(reactivate.json().activeFutureBookings).toBeUndefined();
  });

  it('updates cannot touch another org\'s rows', async () => {
    const { orgId: orgA, password: passA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB, password: passB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'org-b', adminEmail: 'b@b.b', adminName: 'B' });
    const tokenA = await loginAs(app, 'org-a', 'a@a.a', passA);
    const tokenB = await loginAs(app, 'org-b', 'b@b.b', passB);

    const locB = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgB])).rows[0].id;
    
    const createResB = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${tokenB}` }, payload: { locationId: locB, type: 'desk', name: 'Res B', hourlyRateCents: 0, dayRateCents: 0 } });
    expect(createResB.statusCode).toBe(201);
    const resB = createResB.json().resource.id;

    const patchLoc = await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locB}`, headers: { Authorization: `Bearer ${tokenA}` }, payload: { name: 'Hacked' } });
    expect(patchLoc.statusCode).toBe(404); expect(patchLoc.json().error.message).toBe('Location not found');

    const patchLocRand = await app.inject({ method: 'PATCH', url: `/api/v1/locations/00000000-0000-0000-0000-000000000000`, headers: { Authorization: `Bearer ${tokenA}` }, payload: { name: 'Hacked' } });
    expect(patchLocRand.statusCode).toBe(404); expect(patchLocRand.json().error.message).toBe('Location not found');

    const patchRes = await app.inject({ method: 'PATCH', url: `/api/v1/resources/${resB}`, headers: { Authorization: `Bearer ${tokenA}` }, payload: { name: 'Hacked' } });
    expect(patchRes.statusCode).toBe(404); expect(patchRes.json().error.message).toBe('Resource not found');

    const patchResRand = await app.inject({ method: 'PATCH', url: `/api/v1/resources/00000000-0000-0000-0000-000000000000`, headers: { Authorization: `Bearer ${tokenA}` }, payload: { name: 'Hacked' } });
    expect(patchResRand.statusCode).toBe(404); expect(patchResRand.json().error.message).toBe('Resource not found');

    const dbLoc = await testPool.query('SELECT name FROM locations WHERE id = $1', [locB]);
    expect(dbLoc.rows[0].name).not.toBe('Hacked');
    
    const dbResCheck = await testPool.query('SELECT name FROM resources WHERE id = $1', [resB]);
    expect(dbResCheck.rows[0].name).not.toBe('Hacked');
  });

  it('the qr token is generated and never accepted or returned', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);
    const locId = (await testPool.query(`SELECT id FROM locations WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0].id;

    const res1 = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R1', hourlyRateCents: 0, dayRateCents: 0 } });
    expect(res1.statusCode).toBe(201);
    expect(res1.body).not.toContain('qr_token');
    expect(res1.body).not.toContain('qrToken');

    const res2 = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R2', hourlyRateCents: 0, dayRateCents: 0 } });
    expect(res2.statusCode).toBe(201);
    expect(res2.body).not.toContain('qr_token');
    expect(res2.body).not.toContain('qrToken');

    const res3 = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R3', hourlyRateCents: 0, dayRateCents: 0, qrToken: 'hack' } });
    expect(res3.statusCode).toBe(400);

    const dbRes = await testPool.query('SELECT qr_token FROM resources WHERE org_id = $1', [orgId]);
    expect(dbRes.rows.length).toBe(2);
    expect(dbRes.rows[0].qr_token).not.toBe(dbRes.rows[1].qr_token);
    expect(dbRes.rows[0].qr_token.length).toBeGreaterThanOrEqual(32);
  });

  it('every catalog change writes an audit row', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'org-a', 'a@a.a', password);
    
    const locRes = await app.inject({ method: 'POST', url: '/api/v1/locations', headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L', timezone: 'UTC', openHour: '08:00', closeHour: '20:00' } });
    const locId = locRes.json().location.id;

    const resRes = await app.inject({ method: 'POST', url: '/api/v1/resources', headers: { Authorization: `Bearer ${token}` }, payload: { locationId: locId, type: 'desk', name: 'R', hourlyRateCents: 0, dayRateCents: 0 } });
    const resId = resRes.json().resource.id;

    await app.inject({ method: 'PATCH', url: `/api/v1/locations/${locId}`, headers: { Authorization: `Bearer ${token}` }, payload: { name: 'L2' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/resources/${resId}`, headers: { Authorization: `Bearer ${token}` }, payload: { name: 'R2' } });

    const logs = await auditRows(orgId);
    expect(logs.some((l: any) => l.action === 'location.create' && l.actor_id === adminUserId && l.entity_id === locId)).toBe(true);
    expect(logs.some((l: any) => l.action === 'location.update' && l.actor_id === adminUserId && l.entity_id === locId)).toBe(true);
    expect(logs.some((l: any) => l.action === 'resource.create' && l.actor_id === adminUserId && l.entity_id === resId)).toBe(true);
    expect(logs.some((l: any) => l.action === 'resource.update' && l.actor_id === adminUserId && l.entity_id === resId)).toBe(true);
  });
});