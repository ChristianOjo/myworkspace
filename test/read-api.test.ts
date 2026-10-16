// test/read-api.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool, createOrg, createUser, createLocationCustom, createResource, setResourceRates, loginAs, createStaffUser } from './helpers.js';
import { buildApp } from '../src/http/app.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';

let clock = new Date('2030-01-07T08:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('read-api', () => {
  it('locations and resources list only the caller\'s org', async () => {
    const { orgId: orgA, password: passA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB, password: passB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'org-b', adminEmail: 'b@b.b', adminName: 'B' });
    const tokenA = await loginAs(app, 'org-a', 'a@a.a', passA);
    const tokenB = await loginAs(app, 'org-b', 'b@b.b', passB);
    
    const locA = await createLocationCustom(orgA, { timezone: 'UTC', openHour: '08:00', closeHour: '20:00' });
    const resA1 = await createResource(orgA, locA);
    await setResourceRates(resA1, 5000, 40000);
    await testPool.query(`UPDATE resources SET status = 'retired' WHERE id = $1`, [resA1]);
    const resA2 = await createResource(orgA, locA);
    await setResourceRates(resA2, 6000, 50000);
    await testPool.query(`UPDATE resources SET status = 'maintenance' WHERE id = $1`, [resA2]);

    const locB = await createLocationCustom(orgB, { timezone: 'UTC' });
    const resB = await createResource(orgB, locB);

    const locResA = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: { Authorization: `Bearer ${tokenA}` } });
    expect(locResA.statusCode).toBe(200);
    const locIdsA = locResA.json().locations.map((l: any) => l.id);
    expect(locIdsA).toContain(locA);
    expect(locIdsA).not.toContain(locB);

    const locResB = await app.inject({ method: 'GET', url: '/api/v1/locations', headers: { Authorization: `Bearer ${tokenB}` } });
    expect(locResB.statusCode).toBe(200);
    const locIdsB = locResB.json().locations.map((l: any) => l.id);
    expect(locIdsB).toContain(locB);
    expect(locIdsB).not.toContain(locA);

    const resRes = await app.inject({ method: 'GET', url: `/api/v1/resources?locationId=${locA}`, headers: { Authorization: `Bearer ${tokenA}` } });
    expect(resRes.statusCode).toBe(200);
    expect(resRes.json().resources.length).toBe(1);
    expect(resRes.json().resources[0].id).toBe(resA2);
    expect(resRes.json().resources[0].hourlyRateCents).toBe(6000);

    const badLocRes = await app.inject({ method: 'GET', url: `/api/v1/resources?locationId=${locB}`, headers: { Authorization: `Bearer ${tokenA}` } });
    expect(badLocRes.statusCode).toBe(404);
    expect(badLocRes.json().error.message).toBe('Location not found');

    const randomLocRes = await app.inject({ method: 'GET', url: '/api/v1/resources?locationId=00000000-0000-0000-0000-000000000000', headers: { Authorization: `Bearer ${tokenA}` } });
    expect(randomLocRes.statusCode).toBe(404);
    expect(randomLocRes.json().error.message).toBe('Location not found');
  });

  it('the day view lists bookings overlapping the local day in order', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocationCustom(orgId, { timezone: 'America/New_York' });
    const res1 = await createResource(orgId, locId);
    await testPool.query(`UPDATE resources SET name = 'Zebra' WHERE id = $1`, [res1]);
    const res2 = await createResource(orgId, locId);
    await testPool.query(`UPDATE resources SET name = 'Apple' WHERE id = $1`, [res2]);

    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status, customer_name, price_cents) VALUES ($1, $2, $3, tstzrange('2030-01-07T13:00:00Z', '2030-01-07T14:00:00Z', '[)'), 'confirmed', 'John', 5000)`, [orgId, (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id, res1]);
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status, customer_name, price_cents) VALUES ($1, $2, $3, tstzrange('2030-01-07T12:00:00Z', '2030-01-07T13:00:00Z', '[)'), 'confirmed', 'Jane', 5000)`, [orgId, (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id, res2]);

    const dayRes = await app.inject({ method: 'GET', url: '/api/v1/bookings?locationId=' + locId + '&date=2030-01-07', headers: { Authorization: `Bearer ${token}` } });
    expect(dayRes.statusCode).toBe(200);
    expect(dayRes.json().bookings.length).toBe(2);
    expect(dayRes.json().bookings[0].resourceName).toBe('Apple');
    expect(dayRes.json().bookings[1].resourceName).toBe('Zebra');
    expect(dayRes.json().bookings[0].paymentStatus).toBe('unpaid');
  });

  it('the day view hides cancelled bookings unless asked', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T11:00:00Z', '2030-01-07T12:00:00Z', '[)'), 'cancelled')`, [orgId, userId, resId]);

    const defaultRes = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=2030-01-07`, headers: { Authorization: `Bearer ${token}` } });
    expect(defaultRes.json().bookings.length).toBe(1);

    const includeRes = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=2030-01-07&includeCancelled=true`, headers: { Authorization: `Bearer ${token}` } });
    expect(includeRes.json().bookings.length).toBe(2);
  });

  it('the day boundary is half-open in the location\'s timezone', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocationCustom(orgId, { timezone: 'America/New_York' });
    const resId = await createResource(orgId, locId);
    const userId = (await testPool.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [orgId])).rows[0].id;

    // 2030-01-08T05:00:00Z is 2030-01-08T00:00:00 in New York (EST)
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-07T20:00:00Z', '2030-01-08T05:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);
    await testPool.query(`INSERT INTO bookings (org_id, user_id, resource_id, period, status) VALUES ($1, $2, $3, tstzrange('2030-01-08T05:00:00Z', '2030-01-08T06:00:00Z', '[)'), 'confirmed')`, [orgId, userId, resId]);

    const day7Res = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=2030-01-07`, headers: { Authorization: `Bearer ${token}` } });
    expect(day7Res.json().bookings.length).toBe(1);

    const day8Res = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=2030-01-08`, headers: { Authorization: `Bearer ${token}` } });
    expect(day8Res.json().bookings.length).toBe(1);
  });

  it('the day view validates its input', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });

    const res1 = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=2030-02-30`, headers: { Authorization: `Bearer ${token}` } });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error.reason).toBe('invalid_date');

    const res2 = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=not-a-date`, headers: { Authorization: `Bearer ${token}` } });
    expect(res2.statusCode).toBe(400);

    const res3 = await app.inject({ method: 'GET', url: `/api/v1/bookings?date=2030-01-07`, headers: { Authorization: `Bearer ${token}` } });
    expect(res3.statusCode).toBe(400);

    const res4 = await app.inject({ method: 'GET', url: `/api/v1/bookings?locationId=${locId}&date=2030-01-07&includeCancelled=maybe`, headers: { Authorization: `Bearer ${token}` } });
    expect(res4.statusCode).toBe(400);
  });

  it('the daily cash report works over HTTP', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const adminToken = await loginAs(app, 'test', 'a@a.a', password);
    const { email: memberEmail, password: memberPass } = await createStaffUser(orgId, 'member');
    const memberToken = await loginAs(app, 'test', memberEmail, memberPass);
    
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${adminToken}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John' } });
    expect(createRes.statusCode).toBe(201);
    const bookingId = createRes.json().booking.id;

    const payRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/payments`, headers: { Authorization: `Bearer ${memberToken}` }, payload: { amountCents: 2000 } });
    expect(payRes.statusCode).toBe(201);

    await testPool.query(`UPDATE payments SET created_at = '2030-01-07T10:00:00Z' WHERE org_id = $1`, [orgId]);

    const memberReport = await app.inject({ method: 'GET', url: `/api/v1/cash/daily?locationId=${locId}&date=2030-01-07`, headers: { Authorization: `Bearer ${memberToken}` } });
    expect(memberReport.json().staff.length).toBe(1);
    expect(memberReport.json().totals.paymentsCents).toBe(2000);

    const adminReport = await app.inject({ method: 'GET', url: `/api/v1/cash/daily?locationId=${locId}&date=2030-01-07`, headers: { Authorization: `Bearer ${adminToken}` } });
    expect(adminReport.json().staff.length).toBe(1); // Only member made a payment
  });

  it('the cash report validates its query', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocationCustom(orgId, { timezone: 'UTC' });

    const res1 = await app.inject({ method: 'GET', url: `/api/v1/cash/daily?locationId=${locId}&date=2030-02-30`, headers: { Authorization: `Bearer ${token}` } });
    expect(res1.statusCode).toBe(400);

    const res2 = await app.inject({ method: 'GET', url: `/api/v1/cash/daily?locationId=00000000-0000-0000-0000-000000000000&date=2030-01-07`, headers: { Authorization: `Bearer ${token}` } });
    expect(res2.statusCode).toBe(404);
    expect(res2.json().error.message).toBe('Location not found');
  });
});