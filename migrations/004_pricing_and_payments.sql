ALTER TABLE resources
  ADD COLUMN hourly_rate_cents int NOT NULL DEFAULT 0 CHECK (hourly_rate_cents >= 0),
  ADD COLUMN day_rate_cents    int NOT NULL DEFAULT 0 CHECK (day_rate_cents >= 0);

ALTER TABLE bookings
  ADD COLUMN customer_name  text,
  ADD COLUMN customer_phone text,
  ADD COLUMN price_cents    int NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  ADD COLUMN pricing_type   text NOT NULL DEFAULT 'hourly' CHECK (pricing_type IN ('hourly','day')),
  ADD CONSTRAINT bookings_id_org_unique UNIQUE (id, org_id);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  booking_id   uuid NOT NULL,
  amount_cents int NOT NULL,
  kind         text NOT NULL,
  received_by  uuid NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (booking_id, org_id)  REFERENCES bookings(id, org_id),
  FOREIGN KEY (received_by, org_id) REFERENCES users(id, org_id),
  CONSTRAINT payment_kind CHECK (kind IN ('payment','refund')),
  CONSTRAINT payment_sign CHECK (
    (kind = 'payment' AND amount_cents > 0) OR (kind = 'refund' AND amount_cents < 0)
  )
);
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE INDEX payments_org_created_idx ON payments (org_id, created_at);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

-- Append-only: the app role can read and insert, never update or delete.
GRANT SELECT, INSERT ON payments TO app_user;