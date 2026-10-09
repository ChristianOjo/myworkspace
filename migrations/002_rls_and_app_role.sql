-- migrations/002_rls_and_app_role.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;  -- dev-only password
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, locations, resources, bookings TO app_user;
GRANT SELECT, UPDATE ON organizations TO app_user;
-- No default privileges on purpose: every future migration must grant explicitly.
-- app_user gets no access to schema_migrations.

CREATE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

-- organizations: ENABLE only, NOT FORCE, so the table owner (and the SECURITY DEFINER
-- function below, which runs as the owner) can still read it for the slug lookup.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = app_current_org())
  WITH CHECK (id = app_current_org());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON locations
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON resources
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bookings
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

CREATE FUNCTION org_id_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM organizations WHERE slug = p_slug AND deleted_at IS NULL $$;
REVOKE ALL ON FUNCTION org_id_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_id_by_slug(text) TO app_user;