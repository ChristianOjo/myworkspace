CREATE TABLE resource_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  resource_id uuid NOT NULL,
  period      tstzrange NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resource_id, org_id) REFERENCES resources(id, org_id) ON DELETE CASCADE,
  CONSTRAINT block_not_empty CHECK (NOT isempty(period)),
  CONSTRAINT block_bounded   CHECK (NOT lower_inf(period) AND NOT upper_inf(period)),
  CONSTRAINT block_half_open CHECK (lower_inc(period) AND NOT upper_inc(period)),
  CONSTRAINT resource_blocks_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    period WITH &&
  )
);

ALTER TABLE resource_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON resource_blocks
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON resource_blocks TO app_user;