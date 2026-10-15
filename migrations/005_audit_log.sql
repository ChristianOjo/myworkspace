CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id),
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  uuid,
  diff       jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id)
);
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- Append-only: read and insert only.
GRANT SELECT, INSERT ON audit_log TO app_user;