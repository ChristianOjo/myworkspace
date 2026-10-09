-- myworkspace/migrations/001_core_schema.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE resource_type   AS ENUM ('desk','dedicated_desk','meeting_room','phone_booth','parking');
CREATE TYPE resource_status AS ENUM ('active','maintenance','retired');
CREATE TYPE booking_status  AS ENUM ('draft','pending_payment','confirmed','checked_in','completed','cancelled','no_show','expired');
CREATE TYPE user_role       AS ENUM ('org_admin','location_manager','member');

CREATE TABLE organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  plan_type          text NOT NULL DEFAULT 'starter',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_customer_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  email          citext NOT NULL,
  full_name      text NOT NULL,
  role           user_role NOT NULL DEFAULT 'member',
  password_hash  text,
  sso_provider   text,
  sso_subject    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  UNIQUE (org_id, email),
  UNIQUE (sso_provider, sso_subject),
  UNIQUE (id, org_id)
);

CREATE TABLE locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  name       text NOT NULL,
  address    jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone   text NOT NULL DEFAULT 'UTC',
  open_hour  time NOT NULL DEFAULT '08:00',
  close_hour time NOT NULL DEFAULT '20:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);

CREATE TABLE resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  location_id  uuid NOT NULL,
  type         resource_type NOT NULL,
  name         text NOT NULL,
  capacity     int NOT NULL DEFAULT 1,
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  map_position point,
  status       resource_status NOT NULL DEFAULT 'active',
  qr_token     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (location_id, org_id) REFERENCES locations(id, org_id)
);
CREATE INDEX resources_location_idx ON resources (location_id) WHERE status = 'active';

CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  user_id             uuid NOT NULL,
  resource_id         uuid NOT NULL,
  period              tstzrange NOT NULL,
  status              booking_status NOT NULL DEFAULT 'confirmed',
  credits_spent       int NOT NULL DEFAULT 0,
  parent_id           uuid REFERENCES bookings(id) ON DELETE SET NULL,
  checkin_at          timestamptz,
  cancellation_reason text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, org_id)     REFERENCES users(id, org_id),
  FOREIGN KEY (resource_id, org_id) REFERENCES resources(id, org_id),
  CONSTRAINT period_not_empty CHECK (NOT isempty(period)),
  CONSTRAINT period_bounded   CHECK (NOT lower_inf(period) AND NOT upper_inf(period)),
  CONSTRAINT period_half_open CHECK (lower_inc(period) AND NOT upper_inc(period)),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    period WITH &&
  ) WHERE (status IN ('pending_payment','confirmed','checked_in'))
);
CREATE INDEX bookings_user_period_idx ON bookings (user_id, period);