-- migrations/008_customer_portal.sql
-- Self-service customer portal support.
--
-- The existing roles org_admin, location_manager and member remain STAFF roles
-- (front desk, managers and admins). This migration adds a separate 'customer'
-- role for external people who register on the public portal and book their
-- own spaces, plus a contact phone column on the users table.

-- PG 12+: ADD VALUE may run inside the migration transaction; the new value is
-- not referenced until later transactions, which satisfies the same-transaction
-- restriction.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'customer';

-- Contact number for customer accounts. Staff walk-in bookings keep using the
-- free-text bookings.customer_name / bookings.customer_phone columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;

-- No new tables or RLS policies are required:
--   * Public catalog reads resolve the org with the existing SECURITY DEFINER
--     function org_id_by_slug(text) and then scope SELECTs with app.org_id, so
--     the existing tenant RLS policies keep applying.
--   * app_user already holds SELECT on organizations/locations/resources and
--     SELECT, INSERT, UPDATE on users/sessions/bookings.
