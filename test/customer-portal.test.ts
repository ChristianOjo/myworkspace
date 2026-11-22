// test/customer-portal.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  testPool,
  appPool,
  createLocation,
  createResource,
  setResourceRates,
  setResourceStatus,
  createBlock,
  insertBooking,
  insertPaymentAt,
  auditRows,
  loginAs,
  createStaffUser,
} from './helpers.js';
import { buildApp } from '../src/http/app.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';

let clock = new Date('2030-01-07T09:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
  clock = new Date('2030-01-07T09:00:00Z');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

interface RegisteredCustomer {
  token: string;
  userId: string;
  email: string;
  fullName: string;
}

async function registerCustomer(slug: string, overrides: Partial<{ email: string; fullName: string; password: string; phone: string; company: string }> = {}) {
  const email = overrides.email ?? `customer-${Math.random().toString(36).slice(2)}@example.com`;
  const payload = {
    orgSlug: slug,
    fullName: overrides.fullName ?? 'Casey Customer',
    email,
    password: overrides.password ?? 'customer-password-1',
    ...(overrides.phone ? { phone: overrides.phone } : {}),
    ...(overrides.company ? { company: overrides.company } : {}),
  };
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload });
  return { res, email };
}

describe('customer-portal public catalogue', () => {
  it('unknown org slug returns 404 on every public route', async () => {
    for (const url of ['/api/v1/public/no-such-org/org', '/api/v1/public/no-such-org/locations', '/api/v1/public/no-such-org/resources']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.reason).toBe('unknown_org');
    }
  });

  it('returns org, locations and only active resources without a token', async () => {
    const { orgId } = await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocation(orgId);
    const activeId = await createResource(orgId, locId);
    await setResourceRates(activeId, 5000, 40000);
    const retiredId = await createResource(orgId, locId);
    await setResourceStatus(retiredId, 'retired');

    const orgRes = await app.inject({ method: 'GET', url: '/api/v1/public/cafe-works/org' });
    expect(orgRes.statusCode).toBe(200);
    expect(orgRes.json().org.name).toBe('Cafe Works');

    const locRes = await app.inject({ method: 'GET', url: '/api/v1/public/cafe-works/locations' });
    expect(locRes.statusCode).toBe(200);
    expect(locRes.json().locations.length).toBe(1);

    const resRes = await app.inject({ method: 'GET', url: `/api/v1/public/cafe-works/resources?locationId=${locId}` });
    expect(resRes.statusCode).toBe(200);
    expect(resRes.json().resources.map((item: any) => item.id)).toEqual([activeId]);

    await createBlock(orgId, activeId, '2030-01-07T10:00:00Z', '2030-01-07T11:00:00Z');
    const availRes = await app.inject({ method: 'GET', url: `/api/v1/public/cafe-works/availability?locationId=${locId}&date=2030-01-07` });
    expect(availRes.statusCode).toBe(200);
    const availability = availRes.json().availability;
    expect(availability.resources[0].blocks.length).toBe(1);
  });
});

describe('default public organisation (portal slug auto-resolve)', () => {
  it('returns 404 unknown_org when no organisation exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/default-org' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.reason).toBe('unknown_org');
  });

  it('returns the organisation when exactly one exists', async () => {
    await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/default-org' });
    expect(res.statusCode).toBe(200);
    expect(res.json().org).toMatchObject({ slug: 'cafe-works', name: 'Cafe Works' });
  });

  it('refuses to guess when several organisations exist', async () => {
    await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });
    await createOrgWithAdmin(testPool, { orgName: 'Beta Space', slug: 'beta-space', adminEmail: 'b@b.b', adminName: 'B' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/default-org' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.reason).toBe('multiple_orgs');
  });
});

describe('customer registration', () => {
  it('creates a customer account with profile fields and returns a session token', async () => {
    await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });
    const { res } = await registerCustomer('cafe-works', {
      fullName: 'Casey Customer',
      phone: '+268 7600 1234',
      company: 'Acme Trading (Pty) Ltd',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.user.role).toBe('customer');
    expect(body.user.fullName).toBe('Casey Customer');
    expect(body.user.phone).toBe('+268 7600 1234');
    expect(body.user.company).toBe('Acme Trading (Pty) Ltd');

    const dbRows = await testPool.query(`SELECT role, phone, company FROM users WHERE id = $1`, [body.user.id]);
    expect(dbRows.rows[0].role).toBe('customer');
    expect(dbRows.rows[0].company).toBe('Acme Trading (Pty) Ltd');

    const meRes = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { Authorization: `Bearer ${body.token}` } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.role).toBe('customer');
    expect(meRes.json().user.company).toBe('Acme Trading (Pty) Ltd');
  });

  it('stores no company when omitted and rejects an overlong company name', async () => {
    await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });

    const omitted = await registerCustomer('cafe-works');
    expect(omitted.res.statusCode).toBe(201);
    expect(omitted.res.json().user.company).toBeNull();
    const omittedRow = await testPool.query(`SELECT company FROM users WHERE id = $1`, [omitted.res.json().user.id]);
    expect(omittedRow.rows[0].company).toBeNull();

    const tooLong = await registerCustomer('cafe-works', { company: 'x'.repeat(201) });
    expect(tooLong.res.statusCode).toBe(400);
    expect(tooLong.res.json().error.reason).toBe('invalid_company');
  });

  it('rejects duplicate email, weak password and unknown org', async () => {
    await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });

    const first = await registerCustomer('cafe-works', { email: 'same@example.com' });
    expect(first.res.statusCode).toBe(201);

    const duplicate = await registerCustomer('cafe-works', { email: 'same@example.com' });
    expect(duplicate.res.statusCode).toBe(409);
    expect(duplicate.res.json().error.reason).toBe('email_taken');

    const weak = await registerCustomer('cafe-works', { password: 'short' });
    expect(weak.res.statusCode).toBe(400);
    expect(weak.res.json().error.reason).toBe('weak_password');

    const unknownOrg = await registerCustomer('missing-slug');
    expect(unknownOrg.res.statusCode).toBe(404);
    expect(unknownOrg.res.json().error.reason).toBe('unknown_org');
  });
});

describe('customer booking workflow', () => {
  async function seed() {
    const seeded = await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocation(seeded.orgId);
    const hourlyId = await createResource(seeded.orgId, locId);
    await setResourceRates(hourlyId, 5000, 40000);
    const dayId = await createResource(seeded.orgId, locId);
    await setResourceRates(dayId, 5000, 40000);
    return { ...seeded, locId, hourlyId, dayId };
  }

  async function register(slug: string): Promise<RegisteredCustomer> {
    const { res, email } = await registerCustomer(slug);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { token: body.token, userId: body.user.id, email, fullName: body.user.fullName };
  }

  it('books hourly and day slots, lists them, and cancels an unpaid upcoming booking', async () => {
    const seeded = await seed();
    const customer = await register('cafe-works');

    const hourly = await app.inject({
      method: 'POST', url: '/api/v1/me/bookings',
      headers: { Authorization: `Bearer ${customer.token}` },
      payload: { resourceId: seeded.hourlyId, kind: 'hourly', start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', phone: '+268 7600 0001' },
    });
    expect(hourly.statusCode).toBe(201);
    expect(hourly.json().booking.pricing).toBe('hourly');
    expect(hourly.json().booking.priceCents).toBe(5000);
    expect(hourly.json().booking.customerPhone).toBe('+268 7600 0001');

    const hourlyRow = await testPool.query(`SELECT user_id, customer_name FROM bookings WHERE id = $1`, [hourly.json().booking.id]);
    expect(hourlyRow.rows[0].user_id).toBe(customer.userId);
    expect(hourlyRow.rows[0].customer_name).toBe(customer.fullName);

    const day = await app.inject({
      method: 'POST', url: '/api/v1/me/bookings',
      headers: { Authorization: `Bearer ${customer.token}` },
      payload: { resourceId: seeded.dayId, kind: 'day', date: '2030-01-07' },
    });
    expect(day.statusCode).toBe(201);
    expect(day.json().booking.pricing).toBe('day');
    expect(day.json().booking.priceCents).toBe(40000);

    const listRes = await app.inject({ method: 'GET', url: '/api/v1/me/bookings', headers: { Authorization: `Bearer ${customer.token}` } });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().bookings.length).toBe(2);
    const first = listRes.json().bookings[0];
    expect(first.cancelable).toBe(true);

    const detailRes = await app.inject({ method: 'GET', url: `/api/v1/me/bookings/${hourly.json().booking.id}`, headers: { Authorization: `Bearer ${customer.token}` } });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().booking.id).toBe(hourly.json().booking.id);

    const cancelRes = await app.inject({
      method: 'POST', url: `/api/v1/me/bookings/${hourly.json().booking.id}/cancel`,
      headers: { Authorization: `Bearer ${customer.token}` },
      payload: { reason: 'Plans changed' },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().booking.status).toBe('cancelled');

    const again = await app.inject({ method: 'POST', url: `/api/v1/me/bookings/${hourly.json().booking.id}/cancel`, headers: { Authorization: `Bearer ${customer.token}` }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('not_confirmed');

    const logs = await auditRows(seeded.orgId, 'customer_booking.create');
    expect(logs.length).toBe(2);
  });

  it('a customer cannot read another customer booking, and conflicts are rejected', async () => {
    const seeded = await seed();
    const first = await register('cafe-works');
    const second = await register('cafe-works');

    const created = await app.inject({
      method: 'POST', url: '/api/v1/me/bookings',
      headers: { Authorization: `Bearer ${first.token}` },
      payload: { resourceId: seeded.hourlyId, kind: 'hourly', start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z' },
    });
    expect(created.statusCode).toBe(201);

    const forbiddenRead = await app.inject({ method: 'GET', url: `/api/v1/me/bookings/${created.json().booking.id}`, headers: { Authorization: `Bearer ${second.token}` } });
    expect(forbiddenRead.statusCode).toBe(404);

    const conflict = await app.inject({
      method: 'POST', url: '/api/v1/me/bookings',
      headers: { Authorization: `Bearer ${second.token}` },
      payload: { resourceId: seeded.hourlyId, kind: 'hourly', start: '2030-01-07T10:30:00Z', end: '2030-01-07T11:30:00Z' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(['slot_conflict', 'slot_taken']).toContain(conflict.json().error.reason);
  });

  it('paid and already-started bookings cannot be self-cancelled', async () => {
    const seeded = await seed();
    const customer = await register('cafe-works');

    const paid = await app.inject({
      method: 'POST', url: '/api/v1/me/bookings',
      headers: { Authorization: `Bearer ${customer.token}` },
      payload: { resourceId: seeded.hourlyId, kind: 'hourly', start: '2030-01-07T12:00:00Z', end: '2030-01-07T13:00:00Z' },
    });
    expect(paid.statusCode).toBe(201);
    await insertPaymentAt(seeded.orgId, paid.json().booking.id, customer.userId, 'payment', 5000, '2030-01-07T12:05:00Z');

    const paidCancel = await app.inject({ method: 'POST', url: `/api/v1/me/bookings/${paid.json().booking.id}/cancel`, headers: { Authorization: `Bearer ${customer.token}` }, payload: {} });
    expect(paidCancel.statusCode).toBe(422);
    expect(paidCancel.json().error.reason).toBe('paid_booking_cancel');

    const pastId = await insertBooking({ orgId: seeded.orgId, userId: customer.userId, resourceId: seeded.hourlyId, start: '2030-01-07T08:00:00Z', end: '2030-01-07T09:00:00Z', status: 'confirmed' });
    const pastCancel = await app.inject({ method: 'POST', url: `/api/v1/me/bookings/${pastId}/cancel`, headers: { Authorization: `Bearer ${customer.token}` }, payload: {} });
    expect(pastCancel.statusCode).toBe(422);
    expect(pastCancel.json().error.reason).toBe('already_started');
  });
});

describe('role guards', () => {
  it('customers are blocked from staff routes and staff from customer routes', async () => {
    const seeded = await createOrgWithAdmin(testPool, { orgName: 'Cafe Works', slug: 'cafe-works', adminEmail: 'a@a.a', adminName: 'A' });
    const locId = await createLocation(seeded.orgId);
    const resId = await createResource(seeded.orgId, locId);

    const customerReg = await registerCustomer('cafe-works');
    expect(customerReg.res.statusCode).toBe(201);
    const customerToken = customerReg.res.json().token;

    const staffMember = await createStaffUser(seeded.orgId, 'member');
    const memberToken = await loginAs(app, 'cafe-works', staffMember.email, staffMember.password);
    const adminToken = await loginAs(app, 'cafe-works', 'a@a.a', seeded.password);

    const staffRoutes: Array<[string, string, any?]> = [
      ['GET', '/api/v1/locations'],
      ['GET', '/api/v1/resources?locationId=' + locId],
      ['POST', '/api/v1/bookings', { resourceId: resId, start: '2030-01-07T10:00:00Z', end: '2030-01-07T11:00:00Z', customerName: 'X' }],
      ['GET', '/api/v1/cash/daily?locationId=' + locId + '&date=2030-01-07'],
    ];
    for (const [method, url, payload] of staffRoutes) {
      const res = await app.inject({ method, url, headers: { Authorization: `Bearer ${customerToken}` }, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('staff_only');
    }

    const customerRoutes: Array<[string, string, any?]> = [
      ['GET', '/api/v1/me/bookings'],
      ['POST', '/api/v1/me/bookings', { resourceId: resId }],
    ];
    for (const [method, url, payload] of customerRoutes) {
      const asAdmin = await app.inject({ method, url, headers: { Authorization: `Bearer ${adminToken}` }, payload });
      expect(asAdmin.statusCode).toBe(403);
      expect(asAdmin.json().error.reason).toBe('customer_portal_only');

      const asMember = await app.inject({ method, url, headers: { Authorization: `Bearer ${memberToken}` }, payload });
      expect(asMember.statusCode).toBe(403);
      expect(asMember.json().error.reason).toBe('customer_portal_only');
    }

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/me/bookings' });
    expect(unauthenticated.statusCode).toBe(401);
  });
});
