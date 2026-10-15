CREATE FUNCTION list_org_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM organizations WHERE deleted_at IS NULL ORDER BY id $$;
REVOKE ALL ON FUNCTION list_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_org_ids() TO app_user;