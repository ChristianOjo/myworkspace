-- migrations/009_customer_company.sql
-- Optional employer/company name on self-service customer accounts.
-- This is the visitor's own organization for visits/invoices; it is NOT the
-- tenant workspace. Every user still belongs to a workspace via users.org_id,
-- and RLS tenant isolation is unchanged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS company text;
