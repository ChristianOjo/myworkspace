import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { testPool, appPool, createUserWithPassword, createStaffUser, loginAs, auditRows, deactivateUser } from './helpers.js';
import { createOrgWithAdmin } from '../src/auth/bootstrap.js';
import { buildApp } from '../src/http/app.js';

let clock = new Date('2030-01-07T09:00:00Z');
const app = buildApp({ pool: appPool, now: () => clock });

beforeAll(() => {
  process.env.SCRYPT_N = '1024';
});

beforeEach(async () => {
  await testPool.query('TRUNCATE organizations CASCADE');
  clock = new Date('2030-01-07T09:00:00Z');
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('staff-api', () => {
  it('an org_admin can create a staff member who can then log in', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org A', slug: 'org-a', adminEmail: 'admin@orga.com', adminName: 'Admin A'
    });
    const token = await loginAs(app, 'org-a', 'admin@orga.com', adminPass);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${token}` },
      payload: { email: 'new@staff.com', fullName: 'New Staff', role: 'member', password: 'password1234' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe('new@staff.com');
    expect(body.user.password).toBeUndefined();
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.user.password_hash).toBeUndefined();

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'org-a', email: 'new@staff.com', password: 'password1234' }
    });
    expect(loginRes.statusCode).toBe(200);

    const logs = await auditRows(orgId, 'staff.create');
    expect(logs.length).toBe(1);
    expect(Object.keys(logs[0].diff).sort()).toEqual(['email', 'role']);
  });

  it('members and location managers cannot create staff', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org B', slug: 'org-b', adminEmail: 'admin@orgb.com', adminName: 'Admin B'
    });

    const member = await createStaffUser(orgId, 'member');
    const memberToken = await loginAs(app, 'org-b', member.email, member.password);

    const manager = await createStaffUser(orgId, 'location_manager');
    const managerToken = await loginAs(app, 'org-b', manager.email, manager.password);

    const payload = { email: 'x@y.com', fullName: 'X Y', role: 'member', password: 'password1234' };

    const memberRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${memberToken}` },
      payload
    });
    expect(memberRes.statusCode).toBe(403);
    expect(memberRes.json()).toEqual({ error: { code: 'forbidden', reason: 'admin_required', message: 'Admin required' } });

    const managerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${managerToken}` },
      payload
    });
    expect(managerRes.statusCode).toBe(403);
    expect(managerRes.json()).toEqual({ error: { code: 'forbidden', reason: 'admin_required', message: 'Admin required' } });
  });

  it('staff creation validates input', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org C', slug: 'org-c', adminEmail: 'admin@orgc.com', adminName: 'Admin C'
    });
    const token = await loginAs(app, 'org-c', 'admin@orgc.com', adminPass);

    const weakRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${token}` },
      payload: { email: 'a@b.com', fullName: 'A B', role: 'member', password: 'short123' }
    });
    expect(weakRes.statusCode).toBe(400);
    expect(weakRes.json().error.reason).toBe('weak_password');

    const emailRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${token}` },
      payload: { email: 'no-at-sign', fullName: 'A B', role: 'member', password: 'password1234' }
    });
    expect(emailRes.statusCode).toBe(400);
    expect(emailRes.json().error.reason).toBe('invalid_email');

    const roleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${token}` },
      payload: { email: 'a@b.com', fullName: 'A B', role: 'superuser', password: 'password1234' }
    });
    expect(roleRes.statusCode).toBe(400);
    expect(roleRes.json().error.reason).toBe('invalid_role');

    const nameRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${token}` },
      payload: { email: 'a@b.com', fullName: '', role: 'member', password: 'password1234' }
    });
    expect(nameRes.statusCode).toBe(400);
    expect(nameRes.json().error.reason).toBe('invalid_name');

    const count = await testPool.query('SELECT count(*) FROM users WHERE org_id = $1', [orgId]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('duplicate emails are rejected within an org but allowed across orgs', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org D', slug: 'org-d', adminEmail: 'admin@orgd.com', adminName: 'Admin D'
    });
    const { password: admin2Pass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org E', slug: 'org-e', adminEmail: 'admin@orge.com', adminName: 'Admin E'
    });

    const tokenD = await loginAs(app, 'org-d', 'admin@orgd.com', adminPass);
    const tokenE = await loginAs(app, 'org-e', 'admin@orge.com', admin2Pass);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${tokenD}` },
      payload: { email: 'dup@staff.com', fullName: 'First Dup', role: 'member', password: 'password1234' }
    });
    expect(createRes.statusCode).toBe(201);

    const sameEmailRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${tokenD}` },
      payload: { email: 'dup@staff.com', fullName: 'Second Dup', role: 'member', password: 'password1234' }
    });
    expect(sameEmailRes.statusCode).toBe(409);
    expect(sameEmailRes.json()).toEqual({ error: { code: 'conflict', reason: 'email_taken', message: 'Email taken' } });

    const caseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${tokenD}` },
      payload: { email: 'DUP@Staff.com', fullName: 'Case Dup', role: 'member', password: 'password1234' }
    });
    expect(caseRes.statusCode).toBe(409);
    expect(caseRes.json()).toEqual({ error: { code: 'conflict', reason: 'email_taken', message: 'Email taken' } });

    const crossOrgRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${tokenE}` },
      payload: { email: 'dup@staff.com', fullName: 'Cross Org', role: 'member', password: 'password1234' }
    });
    expect(crossOrgRes.statusCode).toBe(201);
  });

  it('managers can list staff and members cannot', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org F', slug: 'org-f', adminEmail: 'admin@orgf.com', adminName: 'Admin F'
    });

    const manager = await createStaffUser(orgId, 'location_manager');
    const member = await createStaffUser(orgId, 'member');

    const adminToken = await loginAs(app, 'org-f', 'admin@orgf.com', adminPass);
    const managerToken = await loginAs(app, 'org-f', manager.email, manager.password);
    const memberToken = await loginAs(app, 'org-f', member.email, member.password);

    const adminListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(adminListRes.statusCode).toBe(200);
    expect(adminListRes.body).not.toContain('password_hash');
    expect(adminListRes.body).not.toContain('scrypt$');

    const managerListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    expect(managerListRes.statusCode).toBe(200);
    expect(managerListRes.body).not.toContain('password_hash');
    expect(managerListRes.body).not.toContain('scrypt$');

    const memberListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    expect(memberListRes.statusCode).toBe(403);
    expect(memberListRes.json().error.reason).toBe('manager_required');
  });

  it('deactivating a staff member revokes their sessions at once', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org G', slug: 'org-g', adminEmail: 'admin@orgg.com', adminName: 'Admin G'
    });

    const staff = await createStaffUser(orgId, 'member');
    const staffToken = await loginAs(app, 'org-g', staff.email, staff.password);
    const adminToken = await loginAs(app, 'org-g', 'admin@orgg.com', adminPass);

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${staffToken}` }
    });
    expect(meRes.statusCode).toBe(200);

    const deactRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${staff.id}/deactivate`,
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(deactRes.statusCode).toBe(200);

    const meAfterRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${staffToken}` }
    });
    expect(meAfterRes.statusCode).toBe(401);
    expect(meAfterRes.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });

    const loginAfterRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'org-g', email: staff.email, password: staff.password }
    });
    expect(loginAfterRes.statusCode).toBe(401);
    expect(loginAfterRes.json()).toEqual({ error: { code: 'unauthenticated', reason: 'invalid_credentials', message: 'Invalid credentials' } });
  });

  it('an admin cannot deactivate themselves', async () => {
    const { orgId, adminUserId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org H', slug: 'org-h', adminEmail: 'admin@orgh.com', adminName: 'Admin H'
    });
    const token = await loginAs(app, 'org-h', 'admin@orgh.com', adminPass);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${adminUserId}/deactivate`,
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.reason).toBe('cannot_deactivate_self');
  });

  it('an org_admin cannot touch another org\'s staff', async () => {
    const { orgId: orgAId, password: adminAPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org I', slug: 'org-i', adminEmail: 'admin@orgi.com', adminName: 'Admin I'
    });
    const { orgId: orgBId, password: adminBPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org J', slug: 'org-j', adminEmail: 'admin@orgj.com', adminName: 'Admin J'
    });

    const staffB = await createStaffUser(orgBId, 'member');
    const tokenA = await loginAs(app, 'org-i', 'admin@orgi.com', adminAPass);
    const randomId = '00000000-0000-0000-0000-000000000000';

    const deactRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${staffB.id}/deactivate`,
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    expect(deactRes.statusCode).toBe(404);
    expect(deactRes.json()).toEqual({ error: { code: 'not_found', message: 'Staff member not found' } });

    const deactRandomRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${randomId}/deactivate`,
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    expect(deactRandomRes.statusCode).toBe(404);
    expect(deactRandomRes.json()).toEqual({ error: { code: 'not_found', message: 'Staff member not found' } });

    const resetRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${staffB.id}/password`,
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: { newPassword: 'newpassword123' }
    });
    expect(resetRes.statusCode).toBe(404);
    expect(resetRes.json()).toEqual({ error: { code: 'not_found', message: 'Staff member not found' } });

    const resetRandomRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${randomId}/password`,
      headers: { Authorization: `Bearer ${tokenA}` },
      payload: { newPassword: 'newpassword123' }
    });
    expect(resetRandomRes.statusCode).toBe(404);
    expect(resetRandomRes.json()).toEqual({ error: { code: 'not_found', message: 'Staff member not found' } });

    const dbRes = await testPool.query('SELECT deactivated_at, password_hash FROM users WHERE id = $1', [staffB.id]);
    expect(dbRes.rows[0].deactivated_at).toBeNull();

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'org-j', email: staffB.email, password: staffB.password }
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('resetting a password revokes the target\'s sessions and the new password works', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org K', slug: 'org-k', adminEmail: 'admin@orgk.com', adminName: 'Admin K'
    });

    const staff = await createStaffUser(orgId, 'member');
    const staffToken = await loginAs(app, 'org-k', staff.email, staff.password);
    const adminToken = await loginAs(app, 'org-k', 'admin@orgk.com', adminPass);

    const resetRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${staff.id}/password`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { newPassword: 'brandnewpass99' }
    });
    expect(resetRes.statusCode).toBe(204);

    const oldLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'org-k', email: staff.email, password: staff.password }
    });
    expect(oldLoginRes.statusCode).toBe(401);

    const newLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { orgSlug: 'org-k', email: staff.email, password: 'brandnewpass99' }
    });
    expect(newLoginRes.statusCode).toBe(200);

    const oldTokenRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { Authorization: `Bearer ${staffToken}` }
    });
    expect(oldTokenRes.statusCode).toBe(401);
  });

  it('no secret ever appears in audit_log', async () => {
    const { orgId, password: adminPass } = await createOrgWithAdmin(testPool, {
      orgName: 'Org L', slug: 'org-l', adminEmail: 'admin@orgl.com', adminName: 'Admin L'
    });
    const adminToken = await loginAs(app, 'org-l', 'admin@orgl.com', adminPass);

    const createPassword = 'createpass123';
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/staff',
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { email: 'audit@staff.com', fullName: 'Audit Staff', role: 'member', password: createPassword }
    });
    expect(createRes.statusCode).toBe(201);
    const staffId = createRes.json().user.id;

    const staffToken = await loginAs(app, 'org-l', 'audit@staff.com', createPassword);

    const resetPassword = 'resetpass456';
    const resetRes = await app.inject({
      method: 'POST',
      url: `/api/v1/staff/${staffId}/password`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { newPassword: resetPassword }
    });
    expect(resetRes.statusCode).toBe(204);

    const newStaffToken = await loginAs(app, 'org-l', 'audit@staff.com', resetPassword);

    const changePassword = 'changepass789';
    const changeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { Authorization: `Bearer ${newStaffToken}` },
      payload: { currentPassword: resetPassword, newPassword: changePassword }
    });
    expect(changeRes.statusCode).toBe(204);

    const logs = await testPool.query('SELECT diff FROM audit_log WHERE org_id = $1', [orgId]);
    const secrets = [createPassword, resetPassword, changePassword];
    for (const row of logs.rows) {
      const diffText = JSON.stringify(row.diff);
      for (const secret of secrets) {
        expect(diffText).not.toContain(secret);
      }
      expect(diffText).not.toContain('scrypt$');
    }
  });
});