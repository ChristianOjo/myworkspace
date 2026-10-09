// test/helpers.ts
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createAppPool } from '../src/db/pool.js';

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