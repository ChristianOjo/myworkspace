// test/booking-api.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, appPool, createOrg, createUser, createLocation, createResource, setResourceRates, loginAs, createStaffUser, auditRows } from './helpers.js';
import { buildApp } from '../src/http/app.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';

let clock = new Date('2030-01-07T08:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
  clock = new Date('2030-01-07T08:00:00Z');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('booking-api', () => {
  it('staff can create an hourly booking over HTTP', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'John Doe' }
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().booking.priceCents).toBe(10000);
    expect(res.json().booking.customerName).toBe('John Doe');
    
    const dbRes = await testPool.query('SELECT user_id FROM bookings WHERE id = $1', [res.json().booking.id]);
    expect(dbRes.rows[0].user_id).toBe(adminUserId);
    
    const logs = await auditRows(orgId, 'booking.create');
    expect(logs.length).toBe(1);
  });

  it('a whole-day booking and a walk-in work over HTTP', async () => {
    const { orgId, adminUserId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId1 = await createResource(orgId, locId);
    const resId2 = await createResource(orgId, locId);
    await setResourceRates(resId1, 5000, 40000);
    await setResourceRates(resId2, 5000, 40000);

    const dayRes = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId1, kind: 'day', date: '2030-01-07', customerName: 'Jane' }
    });
    expect(dayRes.statusCode).toBe(201);
    expect(dayRes.json().booking.pricing).toBe('day');
    expect(dayRes.json().booking.priceCents).toBe(40000);

    clock = new Date('2030-01-07T09:05:00Z');
    const walkInRes = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId2, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'Walk', arrivedNow: true }
    });
    expect(walkInRes.statusCode).toBe(201);
    expect(walkInRes.json().booking.status).toBe('checked_in');
  });

  it('customer name is required', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);

    const res1 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' } });
    expect(res1.statusCode).toBe(400);

    const res2 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: '' } });
    expect(res2.statusCode).toBe(400);

    const res3 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: '   ' } });
    expect(res3.statusCode).toBe(400);
  });

  it('failures map to their HTTP status', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);

    const payload = { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John' };
    await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload });
    
    const conflictRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json().error.code).toBe('slot_conflict');

    const hoursRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { ...payload, start: '2030-01-08T06:00:00Z', end: '2030-01-08T07:00:00Z' } });
    expect(hoursRes.statusCode).toBe(422);
    expect(hoursRes.json().error.reason).toBe('outside_hours');

    const notFoundRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { ...payload, resourceId: '00000000-0000-0000-0000-000000000000' } });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.json().error.code).toBe('not_found');

    const kindRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { ...payload, kind: 'weekly' } });
    expect(kindRes.statusCode).toBe(400);
  });

  it('org and user come from the session, never the body', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John', orgId: '00000000-0000-0000-0000-000000000000' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('every booking route requires authentication', async () => {
    const routes = [
      { method: 'GET', url: '/api/v1/bookings?locationId=00000000-0000-0000-0000-000000000000&date=2030-01-07' },
      { method: 'GET', url: '/api/v1/bookings/00000000-0000-0000-0000-000000000000' },
      { method: 'POST', url: '/api/v1/bookings', payload: { resourceId: '00000000-0000-0000-0000-000000000000', customerName: 'A' } },
      { method: 'POST', url: '/api/v1/bookings/00000000-0000-0000-0000-000000000000/arrived' },
      { method: 'POST', url: '/api/v1/bookings/00000000-0000-0000-0000-000000000000/cancel', payload: {} },
      { method: 'POST', url: '/api/v1/bookings/00000000-0000-0000-0000-000000000000/release' },
      { method: 'POST', url: '/api/v1/bookings/00000000-0000-0000-0000-000000000000/payments', payload: { amountCents: 100 } },
      { method: 'POST', url: '/api/v1/bookings/00000000-0000-0000-0000-000000000000/refunds', payload: { amountCents: 100 } }
    ];
    for (const r of routes) {
      const res = await app.inject({ method: r.method as any, url: r.url, payload: (r as any).payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
    }
  });

  it('arrived, release and cancel work over HTTP', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);

    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z', customerName: 'John' }
    });
    const bookingId = createRes.json().booking.id;

    clock = new Date('2030-01-07T08:50:00Z');
    const arrivedRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/arrived`, headers: { Authorization: `Bearer ${token}` } });
    expect(arrivedRes.statusCode).toBe(200);
    expect(arrivedRes.json().booking.status).toBe('checked_in');

    clock = new Date('2030-01-07T11:07:00Z');
    const releaseRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/release`, headers: { Authorization: `Bearer ${token}` } });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().booking.status).toBe('completed');
    expect(releaseRes.json().booking.end).toBe('2030-01-07T11:15:00.000Z');

    const createRes2 = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { resourceId: resId, start: '2030-01-07T13:00:00Z', end: '2030-01-07T14:00:00Z', customerName: 'Jane' }
    });
    const bookingId2 = createRes2.json().booking.id;
    const cancelRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId2}/cancel`, headers: { Authorization: `Bearer ${token}` }, payload: { reason: 'Test' } });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().booking.status).toBe('cancelled');
  });

  it('cancel and refund rules are enforced over HTTP', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const adminToken = await loginAs(app, 'test', 'a@a.a', password);
    const { id: memberId, email: memberEmail, password: memberPass } = await createStaffUser(orgId, 'member');
    const memberToken = await loginAs(app, 'test', memberEmail, memberPass);
    
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${adminToken}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John' } });
    expect(createRes.statusCode).toBe(201);
    const bookingId = createRes.json().booking.id;

    const payRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/payments`, headers: { Authorization: `Bearer ${adminToken}` }, payload: { amountCents: 2000 } });
    expect(payRes.statusCode).toBe(201);

    const memberCancelRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/cancel`, headers: { Authorization: `Bearer ${memberToken}` }, payload: { refundCents: 1000 } });
    expect(memberCancelRes.statusCode).toBe(403);
    expect(memberCancelRes.json().error.reason).toBe('manager_required');

    const adminCancelRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/cancel`, headers: { Authorization: `Bearer ${adminToken}` }, payload: { refundCents: 1500 } });
    expect(adminCancelRes.statusCode).toBe(200);
    expect(adminCancelRes.json().refund.amountCents).toBe(-1500);
  });

  it('payments and refunds work over HTTP', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const adminToken = await loginAs(app, 'test', 'a@a.a', password);
    const { email: memberEmail, password: memberPass } = await createStaffUser(orgId, 'member');
    const memberToken = await loginAs(app, 'test', memberEmail, memberPass);
    
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${adminToken}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John' } });
    expect(createRes.statusCode).toBe(201);
    const bookingId = createRes.json().booking.id;

    const payRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/payments`, headers: { Authorization: `Bearer ${adminToken}` }, payload: { amountCents: 2000 } });
    expect(payRes.statusCode).toBe(201);
    expect(payRes.json().balance.paymentStatus).toBe('partial');

    const overpayRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/payments`, headers: { Authorization: `Bearer ${adminToken}` }, payload: { amountCents: 90000 } });
    expect(overpayRes.statusCode).toBe(422);
    expect(overpayRes.json().error.reason).toBe('overpayment');

    const memberRefundRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/refunds`, headers: { Authorization: `Bearer ${memberToken}` }, payload: { amountCents: 1000 } });
    expect(memberRefundRes.statusCode).toBe(403);
    expect(memberRefundRes.json().error.reason).toBe('manager_required');

    const adminRefundRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/refunds`, headers: { Authorization: `Bearer ${adminToken}` }, payload: { amountCents: 1000 } });
    expect(adminRefundRes.statusCode).toBe(201);
  });

  it('booking detail includes balance and payment history', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);
    const locId = await createLocation(orgId);
    const resId = await createResource(orgId, locId);
    await setResourceRates(resId, 5000, 40000);
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${token}` }, payload: { resourceId: resId, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John' } });
    expect(createRes.statusCode).toBe(201);
    const bookingId = createRes.json().booking.id;

    const payRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/payments`, headers: { Authorization: `Bearer ${token}` }, payload: { amountCents: 2000, note: 'Cash' } });
    expect(payRes.statusCode).toBe(201);
    const refRes = await app.inject({ method: 'POST', url: `/api/v1/bookings/${bookingId}/refunds`, headers: { Authorization: `Bearer ${token}` }, payload: { amountCents: 500 } });
    expect(refRes.statusCode).toBe(201);

    const detailRes = await app.inject({ method: 'GET', url: `/api/v1/bookings/${bookingId}`, headers: { Authorization: `Bearer ${token}` } });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().balance.paidCents).toBe(2000);
    expect(detailRes.json().balance.refundedCents).toBe(500);
    expect(detailRes.json().payments.length).toBe(2);
    expect(detailRes.json().payments[0].receivedByName).toBe('A');
  });

  it('an unknown booking id and another org\'s booking id return identical 404s', async () => {
    const { orgId: orgA, password: passA } = await createOrgWithAdmin(testPool, { orgName: 'A', slug: 'org-a', adminEmail: 'a@a.a', adminName: 'A' });
    const { orgId: orgB, password: passB } = await createOrgWithAdmin(testPool, { orgName: 'B', slug: 'org-b', adminEmail: 'b@b.b', adminName: 'B' });
    const tokenA = await loginAs(app, 'org-a', 'a@a.a', passA);
    const tokenB = await loginAs(app, 'org-b', 'b@b.b', passB);

    const locIdB = await createLocation(orgB);
    const resIdB = await createResource(orgB, locIdB);
    const createResB = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers: { Authorization: `Bearer ${tokenB}` }, payload: { resourceId: resIdB, start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z', customerName: 'John' } });
    const bookingIdB = createResB.json().booking.id;

    const routes = [
      { method: 'GET', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000` },
      { method: 'GET', url: `/api/v1/bookings/${bookingIdB}` },
      { method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/arrived` },
      { method: 'POST', url: `/api/v1/bookings/${bookingIdB}/arrived` },
      { method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/cancel`, payload: {} },
      { method: 'POST', url: `/api/v1/bookings/${bookingIdB}/cancel`, payload: {} },
      { method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/release` },
      { method: 'POST', url: `/api/v1/bookings/${bookingIdB}/release` },
      { method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/payments`, payload: { amountCents: 100 } },
      { method: 'POST', url: `/api/v1/bookings/${bookingIdB}/payments`, payload: { amountCents: 100 } },
      { method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/refunds`, payload: { amountCents: 100 } },
      { method: 'POST', url: `/api/v1/bookings/${bookingIdB}/refunds`, payload: { amountCents: 100 } }
    ];

    for (let i = 0; i < routes.length; i += 2) {
      const res1 = await app.inject({ method: routes[i].method as any, url: routes[i].url, headers: { Authorization: `Bearer ${tokenA}` }, payload: (routes[i] as any).payload });
      const res2 = await app.inject({ method: routes[i+1].method as any, url: routes[i+1].url, headers: { Authorization: `Bearer ${tokenA}` }, payload: (routes[i+1] as any).payload });
      expect(res1.statusCode).toBe(404);
      expect(res2.statusCode).toBe(404);
      expect(res1.json()).toEqual({ error: { code: 'not_found', message: 'Booking not found' } });
      expect(res2.json()).toEqual({ error: { code: 'not_found', message: 'Booking not found' } });
    }
  });

  it('invalid ids, bodies and types return 400', async () => {
    const { orgId, password } = await createOrgWithAdmin(testPool, { orgName: 'Test', slug: 'test', adminEmail: 'a@a.a', adminName: 'A' });
    const token = await loginAs(app, 'test', 'a@a.a', password);

    const res1 = await app.inject({ method: 'GET', url: `/api/v1/bookings/invalid-id`, headers: { Authorization: `Bearer ${token}` } });
    expect(res1.statusCode).toBe(400);

    const res2 = await app.inject({ method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/payments`, headers: { Authorization: `Bearer ${token}` }, payload: { amountCents: '100' } });
    expect(res2.statusCode).toBe(400);

    const res3 = await app.inject({ method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/payments`, headers: { Authorization: `Bearer ${token}` }, payload: { amountCents: 10.5 } });
    expect(res3.statusCode).toBe(400);

    const res4 = await app.inject({ method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/payments`, headers: { Authorization: `Bearer ${token}` }, payload: { amountCents: -10 } });
    expect(res4.statusCode).toBe(400);

    const res5 = await app.inject({ method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/payments`, headers: { Authorization: `Bearer ${token}` }, payload: { amountCents: 100, extra: 'field' } });
    expect(res5.statusCode).toBe(400);

    const res6 = await app.inject({ method: 'POST', url: `/api/v1/bookings/00000000-0000-0000-0000-000000000000/arrived`, headers: { Authorization: `Bearer ${token}` }, payload: { extra: 'field' } });
    expect(res6.statusCode).toBe(400);
  });
});