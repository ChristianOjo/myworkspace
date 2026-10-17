// test/helpers.ts
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createAppPool } from '../src/db/pool.js';
import { hashPassword } from '../src/auth/passwords.js';

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgres://myworkspace:myworkspace@localhost:5432/myworkspace_test';
export const testPool = new Pool({ connectionString: testDbUrl, max: 25 });

export const appPool = createAppPool(
  process.env.TEST_APP_DATABASE_URL ?? 'postgres://app_user:app_user@localhost:5432/myworkspace_test',
  5
);

export async function createOrg() {
  const res = await testPool.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Org ${randomUUID()}`, `slug-${randomUUID()}`]
  );
  return res.rows[0].id;
}

export async function createUser(orgId: string, email?: string) {
  const userEmail = email || `user-${randomUUID()}@example.com`;
  const res = await testPool.query(
    `INSERT INTO users (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, userEmail, `User ${randomUUID()}`]
  );
  return res.rows[0].id;
}

export async function createLocation(orgId: string) {
  const res = await testPool.query(
    `INSERT INTO locations (org_id, name) VALUES ($1, $2) RETURNING id`,
    [orgId, `Location ${randomUUID()}`]
  );
  return res.rows[0].id;
}

export async function createLocationCustom(orgId: string, opts: { timezone?: string, openHour?: string, closeHour?: string }) {
  const res = await testPool.query(
    `INSERT INTO locations (org_id, name, timezone, open_hour, close_hour) 
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Location ${randomUUID()}`, opts.timezone || 'UTC', opts.openHour || '08:00', opts.closeHour || '20:00']
  );
  return res.rows[0].id;
}

export async function createResource(orgId: string, locationId: string) {
  const res = await testPool.query(
    `INSERT INTO resources (org_id, location_id, type, name, qr_token) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, locationId, 'desk', `Resource ${randomUUID()}`, `qr-${randomUUID()}`]
  );
  return res.rows[0].id;
}

export async function insertBooking({
  orgId,
  userId,
  resourceId,
  start,
  end,
  status = 'confirmed',
}: {
  orgId: string;
  userId: string;
  resourceId: string;
  start: string;
  end: string;
  status?: string;
}) {
  const res = await testPool.query(
    `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6) RETURNING id`,
    [orgId, userId, resourceId, start, end, status]
  );
  return res.rows[0].id;
}

export async function createBlock(orgId: string, resourceId: string, start: string, end: string) {
  const res = await testPool.query(
    `INSERT INTO resource_blocks (org_id, resource_id, period) 
     VALUES ($1, $2, tstzrange($3, $4, '[)')) RETURNING id`,
    [orgId, resourceId, start, end]
  );
  return res.rows[0].id;
}

export async function setResourceStatus(resourceId: string, status: string) {
  await testPool.query(`UPDATE resources SET status = $1 WHERE id = $2`, [status, resourceId]);
}

export async function deactivateUser(userId: string) {
  await testPool.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [userId]);
}

export async function setResourceRates(resourceId: string, hourlyRateCents: number, dayRateCents: number) {
  await testPool.query(`UPDATE resources SET hourly_rate_cents = $1, day_rate_cents = $2 WHERE id = $3`, [hourlyRateCents, dayRateCents, resourceId]);
}

export async function createBookingRow(orgId: string, userId: string, resourceId: string) {
  const res = await testPool.query(
    `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
     VALUES ($1, $2, $3, tstzrange('2030-01-07T09:00:00Z', '2030-01-07T10:00:00Z', '[)'), 'confirmed') RETURNING id`,
    [orgId, userId, resourceId]
  );
  return res.rows[0].id;
}

export async function createStaff(orgId: string, role: string, fullName?: string) {
  const name = fullName || `Staff ${randomUUID()}`;
  const res = await testPool.query(
    `INSERT INTO users (org_id, email, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `staff-${randomUUID()}@example.com`, name, role]
  );
  return res.rows[0].id;
}

export async function insertPaymentAt(orgId: string, bookingId: string, receivedBy: string, kind: string, amountCents: number, createdAt: string) {
  const res = await testPool.query(
    `INSERT INTO payments (org_id, booking_id, received_by, kind, amount_cents, created_at) 
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, bookingId, receivedBy, kind, amountCents, createdAt]
  );
  return res.rows[0].id;
}

export async function auditRows(orgId: string, action?: string) {
  if (action) {
    const res = await testPool.query(
      `SELECT * FROM audit_log WHERE org_id = $1 AND action = $2 ORDER BY id`,
      [orgId, action]
    );
    return res.rows;
  }
  const res = await testPool.query(
    `SELECT * FROM audit_log WHERE org_id = $1 ORDER BY id`,
    [orgId]
  );
  return res.rows;
}

export async function seedTwoOrgs() {
  const orgAId = await testPool.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    ['Org A', 'org-a-slug']
  ).then(r => r.rows[0].id);
  
  const userA1 = await testPool.query(
    `INSERT INTO users (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [orgAId, 'ana@x.com', 'Ana A']
  ).then(r => r.rows[0].id);
  
  const userA2 = await testPool.query(
    `INSERT INTO users (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [orgAId, 'ben@x.com', 'Ben A']
  ).then(r => r.rows[0].id);

  const locAId = await testPool.query(
    `INSERT INTO locations (org_id, name) VALUES ($1, $2) RETURNING id`,
    [orgAId, 'Location A']
  ).then(r => r.rows[0].id);

  const resA1 = await testPool.query(
    `INSERT INTO resources (org_id, location_id, type, name, qr_token) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgAId, locAId, 'desk', 'Resource A1', `qr-a1-${randomUUID()}`]
  ).then(r => r.rows[0].id);

  const resA2 = await testPool.query(
    `INSERT INTO resources (org_id, location_id, type, name, qr_token) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgAId, locAId, 'desk', 'Resource A2', `qr-a2-${randomUUID()}`]
  ).then(r => r.rows[0].id);

  const bookA1 = await testPool.query(
    `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6) RETURNING id`,
    [orgAId, userA1, resA1, '2024-01-01T09:00:00Z', '2024-01-01T12:00:00Z', 'confirmed']
  ).then(r => r.rows[0].id);

  const bookA2 = await testPool.query(
    `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6) RETURNING id`,
    [orgAId, userA2, resA2, '2024-01-01T13:00:00Z', '2024-01-01T15:00:00Z', 'confirmed']
  ).then(r => r.rows[0].id);

  const orgBId = await testPool.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    ['Org B', 'org-b-slug']
  ).then(r => r.rows[0].id);
  
  const userB1 = await testPool.query(
    `INSERT INTO users (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [orgBId, 'ana@x.com', 'Ana B']
  ).then(r => r.rows[0].id);
  
  const userB2 = await testPool.query(
    `INSERT INTO users (org_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [orgBId, 'ben@x.com', 'Ben B']
  ).then(r => r.rows[0].id);

  const locBId = await testPool.query(
    `INSERT INTO locations (org_id, name) VALUES ($1, $2) RETURNING id`,
    [orgBId, 'Location B']
  ).then(r => r.rows[0].id);

  const resB1 = await testPool.query(
    `INSERT INTO resources (org_id, location_id, type, name, qr_token) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgBId, locBId, 'desk', 'Resource B1', `qr-b1-${randomUUID()}`]
  ).then(r => r.rows[0].id);

  const resB2 = await testPool.query(
    `INSERT INTO resources (org_id, location_id, type, name, qr_token) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgBId, locBId, 'desk', 'Resource B2', `qr-b2-${randomUUID()}`]
  ).then(r => r.rows[0].id);

  const bookB1 = await testPool.query(
    `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6) RETURNING id`,
    [orgBId, userB1, resB1, '2024-01-01T09:00:00Z', '2024-01-01T12:00:00Z', 'confirmed']
  ).then(r => r.rows[0].id);

  const bookB2 = await testPool.query(
    `INSERT INTO bookings (org_id, user_id, resource_id, period, status) 
     VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6) RETURNING id`,
    [orgBId, userB2, resB2, '2024-01-01T13:00:00Z', '2024-01-01T15:00:00Z', 'confirmed']
  ).then(r => r.rows[0].id);

  return {
    A: {
      orgId: orgAId,
      slug: 'org-a-slug',
      userIds: [userA1, userA2],
      locationId: locAId,
      resourceIds: [resA1, resA2],
      bookingIds: [bookA1, bookA2],
    },
    B: {
      orgId: orgBId,
      slug: 'org-b-slug',
      userIds: [userB1, userB2],
      locationId: locBId,
      resourceIds: [resB1, resB2],
      bookingIds: [bookB1, bookB2],
    },
  };
}

export async function createUserWithPassword(orgId: string, opts: { email: string; role: string; password: string; fullName?: string }) {
  const name = opts.fullName || `User ${opts.email}`;
  const hash = await hashPassword(opts.password, { N: 1024 });
  const res = await testPool.query(
    `INSERT INTO users (org_id, email, full_name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, opts.email, name, opts.role, hash]
  );
  return res.rows[0].id;
}

export async function getSessionRows(orgId: string) {
  const res = await testPool.query(`SELECT * FROM sessions WHERE org_id = $1`, [orgId]);
  return res.rows;
}

export async function loginAs(app: any, orgSlug: string, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { orgSlug, email, password }
  });
  if (res.statusCode !== 200) throw new Error(`Login failed: ${res.statusCode} ${res.body}`);
  return res.json().token;
}

export async function createStaffUser(orgId: string, role: string, opts?: { email?: string; password?: string; fullName?: string }) {
  const email = opts?.email || `staff-${randomUUID()}@example.com`;
  const password = opts?.password || 'password123456';
  const fullName = opts?.fullName || `Staff ${role}`;
  const id = await createUserWithPassword(orgId, { email, role, password, fullName });
  return { id, email, password };
}

export async function createResourceWithRates(orgId: string, locationId: string, hourly: number, daily: number) {
  const id = await createResource(orgId, locationId);
  await setResourceRates(id, hourly, daily);
  return id;
}