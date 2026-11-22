# Myworkspace

Multi-tenant booking platform for commercial offices. Front-desk staff book desks, meeting rooms, phone booths and parking, check people in, take cash payments and refunds, and close the day with a cash report.

Backend is Fastify + PostgreSQL (TypeScript). The staff web client is React + Vite. In production both ship as a single Docker image.

## Features

- **Resource booking** for `desk`, `dedicated_desk`, `meeting_room`, `phone_booth` and `parking`, priced hourly or per day.
- **No double-booking, enforced by the database.** A Postgres `EXCLUDE USING gist` constraint rejects overlapping active bookings, so races between two front-desk users can't produce a conflict.
- **15-minute slots.** Hourly bookings must start and end on a 15-minute boundary.
- **Booking lifecycle:** `pending_payment` → `confirmed` → `checked_in` → `completed`, plus `cancelled`, `no_show` and `expired`. Staff mark arrivals, cancel, or release a booking early.
- **Cash handling:** payments and refunds are recorded per booking, with a daily cash report per location.
- **Maintenance blocks** take a resource out of service for a time range, also overlap-protected.
- **Multi-tenancy via Row Level Security.** Every org's data is isolated at the database level. The server connects as a restricted `app_user` role, never as the owner.
- **Roles:** `org_admin`, `location_manager`, `member` (staff) and `customer` (self-service portal).
- **Customer self-service portal.** Visitors browse the public catalogue (locations, active spaces, live availability), register an account, book hourly or whole-day slots, view their own bookings and cancel unpaid upcoming reservations. The staff front desk and the customer portal are separate UIs on separate routes and are enforced separately by role.
- **Audit log** for staff, customer and payment actions.
- **Background sweepers** (every 60 s): confirmed bookings that were never checked in become `no_show` (15-minute grace on hourly bookings; day bookings after the day ends), and checked-in bookings whose period has ended become `completed`.
- **Hardening:** login rate limiting (5 attempts/account and 30/IP per 15 min), security headers, strict CORS, production config validation that refuses to boot with dev credentials.

## Stack

| Layer | Tech |
|---|---|
| API | Node 24, Fastify 5, `pg` |
| Database | PostgreSQL 16+ (`btree_gist`, `citext`, `pgcrypto`) |
| Web | React 19, Vite 6 |
| Tests | Vitest (API), Node test runner (web helpers) |
| Deploy | Docker, Render blueprint (`render.yaml`) |

## Quick start (local)

Requires Node 24, npm and Docker.

```bash
npm install
npm run db:up        # Postgres 16 in Docker on :5432
npm run migrate      # applies migrations/*.sql, creates the app_user role
```

The server does **not** load `.env` on its own. Export the variables in your shell (see [Configuration](#configuration)), or the defaults below will apply to your session:

```bash
# bash / zsh
export DATABASE_URL=postgres://myworkspace:myworkspace@localhost:5432/myworkspace
export APP_DATABASE_URL=postgres://app_user:app_user@localhost:5432/myworkspace
export CORS_ORIGINS=http://localhost:5173
```

```powershell
# PowerShell
$env:DATABASE_URL = "postgres://myworkspace:myworkspace@localhost:5432/myworkspace"
$env:APP_DATABASE_URL = "postgres://app_user:app_user@localhost:5432/myworkspace"
$env:CORS_ORIGINS = "http://localhost:5173"
```

Create your first organization and admin (prints a generated password once):

```bash
npm run create-org -- \
  --org-name "Acme Offices" --slug acme \
  --admin-email admin@acme.test --admin-name "Ada Admin" \
  --timezone Africa/Lagos
```

Start the API and the web client:

```bash
npm run dev                  # API on http://127.0.0.1:3000

cd web
npm install
npm run dev                  # UI on http://localhost:5173
```

Stop the database with `npm run db:down`.

## Scripts

Root (API):

| Command | What it does |
|---|---|
| `npm run dev` | Run the API with `tsx` |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run migrate` | Apply pending migrations (dev) |
| `npm run migrate:prod` | Apply migrations and set the `app_user` password from `APP_USER_PASSWORD` |
| `npm run preflight` | Check the target database (version, extensions, privileges) before migrating |
| `npm run create-org` | Create an organization, default location and admin user |
| `npm test` | Run the API test suite |
| `npm run db:up` / `db:down` | Start / stop the local Postgres container |

Web (`web/`): `npm run dev`, `npm test`, `npm run build` (type-check + production build).

## Configuration

All configuration is via environment variables. See `.env.example` and `web/.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on strict validation |
| `PORT` / `HOST` | `3000` / `127.0.0.1` (`0.0.0.0` in production) | |
| `DATABASE_URL` | none | **Owner** role. Used for migrations, preflight and bootstrap only |
| `APP_DATABASE_URL` | none | **`app_user`** role. Used by the running server. Must differ from `DATABASE_URL` in production |
| `DB_SSL` | `off` (`require` in production) | `off`, `require` or `no-verify` |
| `DB_POOL_MAX` | `10` | 1–50 |
| `CORS_ORIGINS` | empty | Comma-separated exact origins. No `*` in production |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |
| `STATIC_DIR` | empty | Directory of the built web app. Enables serving the UI from the API |
| `SCHEDULER` | `on` | `off` disables the sweepers (useful for extra replicas) |
| `APP_USER_PASSWORD` | none | 16–200 chars. Required in production; applied to `app_user` on migrate |
| `RUN_MIGRATIONS_ON_START` | `false` | Run preflight and migrations at boot |
| `BOOTSTRAP_*` | none | `ORG_NAME`, `ORG_SLUG`, `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (10–200 chars), optional `TIMEZONE` (default `UTC`). Creates the org on first boot; skipped if the slug already exists. All five required if any is set |
| `VITE_API_BASE_URL` | `http://127.0.0.1:3000` | Web client only; set empty when the API serves the UI |
| `VITE_DEFAULT_ORG_SLUG` | empty | Customer portal only; pins the workspace slug at build time. When empty, the portal calls `GET /public/default-org` and hides the slug field for the single deployed workspace |

In production, `APP_DATABASE_URL` can be omitted if `APP_DB_HOST`, `APP_DB_NAME`, `APP_DB_PORT` and `APP_USER_PASSWORD` are set. The URL is built for you.

## Testing

```bash
npm run db:up
npm test
```

The test suite drops and recreates a `myworkspace_test` database on the local Postgres (`postgres://myworkspace:myworkspace@localhost:5432`), runs all migrations, then executes the tests. Override the target with `TEST_DATABASE_URL`. Coverage includes booking constraints, pricing, cash, tenant isolation, sessions, auth, rate limiting, CORS, security headers and the sweepers.

## Deployment

### Docker

```bash
docker build -t myworkspace .
docker run -p 3000:3000 \
  -e DATABASE_URL=... -e APP_DATABASE_URL=... -e APP_USER_PASSWORD=... \
  -e RUN_MIGRATIONS_ON_START=true \
  -e BOOTSTRAP_ORG_NAME=... -e BOOTSTRAP_ORG_SLUG=... \
  -e BOOTSTRAP_ADMIN_EMAIL=... -e BOOTSTRAP_ADMIN_NAME=... -e BOOTSTRAP_ADMIN_PASSWORD=... \
  myworkspace
```

The image is a three-stage build (web, API, runtime), runs as the non-root `node` user, serves the UI from `/app/public`, and exposes `GET /health` for health checks.

### Render

`render.yaml` is a blueprint for a free web service plus a free Postgres database in Frankfurt. It wires the database connection, generates `APP_USER_PASSWORD`, and enables migrate-on-start. The `BOOTSTRAP_*` values are marked `sync: false`, so Render prompts you for them on first deploy.

Free-tier caveat: Render's free web services sleep when idle (so the background sweepers pause) and free Postgres databases expire. Use a paid plan for real use.

## Project layout

```
src/
  http/        Fastify app, server, static serving, rate limiting
  auth/        login, sessions, passwords, staff management, org bootstrap
  booking/     create, check-in, cancel, release, pricing
  catalog/     locations and resources
  cash/        payments, refunds, daily report
  read/        read-side queries
  jobs/        scheduler and sweepers
  ops/         startup tasks, preflight, app_user password
  db/          pool, per-org transactions (withOrg), migration runner
migrations/    001–008 SQL (schema, RLS, blocks, pricing/payments, audit, sessions, system functions, customer portal)
scripts/       create-org, preflight, migrate-prod
test/          API tests
web/           React clients: `src/` staff front desk (`index.html`) and `src/portal/` customer portal (`portal.html`, served at `/portal`)
```

## API

All routes are under `/api/v1`. The public catalogue and registration are unauthenticated; staff routes require a staff session (`org_admin`, `location_manager` or `member`); the `/me/*` routes require a `customer` session. Shared account actions (`/auth/me`, `/auth/logout`, `/auth/password`) work for both.

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Public catalogue | `GET /public/default-org`, `GET /public/:slug/org`, `GET /public/:slug/locations`, `GET /public/:slug/resources`, `GET /public/:slug/availability` |
| Auth | `POST /auth/login`, `POST /auth/register`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password` |
| Customer bookings | `GET /me/bookings`, `GET /me/bookings/:id`, `POST /me/bookings`, `POST /me/bookings/:id/cancel` |
| Staff | `GET /staff`, `POST /staff`, `POST /staff/:id/deactivate`, `POST /staff/:id/password` |
| Locations | `GET /locations`, `POST /locations`, `PATCH /locations/:id` |
| Resources | `GET /resources`, `POST /resources`, `PATCH /resources/:id` |
| Bookings (desk) | `GET /bookings`, `GET /bookings/:id`, `POST /bookings`, `POST /bookings/:id/arrived`, `/cancel`, `/release` |
| Payments | `POST /bookings/:id/payments`, `POST /bookings/:id/refunds` |
| Cash | `GET /cash/daily` |
| Blocks | `GET /resources/:id/blocks`, `POST /resources/:id/blocks`, `DELETE /blocks/:id` |

### Customer portal notes

- The customer UI is served from `/portal`; the staff front desk remains at `/`.
- A customer account is created through `POST /auth/register` with the org slug, name, email, password and optional phone. The slug still goes to the API because every account belongs to a workspace (tenant isolation), but the portal resolves it automatically on single-workspace deployments via `GET /public/default-org` so visitors never type it; the slug input remains as a fallback for multi-workspace installs. Staff accounts are still created by an admin.
- `POST /me/bookings` creates a booking owned by the caller; the walk-in name on the booking comes from the profile. Customers cannot check themselves in or record payments.
- Customers can cancel only their own `confirmed`, unpaid, upcoming bookings; paid and already-started bookings are handled by the front desk.
- There is no online payment gateway in this build: reservations are confirmed and settled in cash at the desk, matching the existing cash flow.

## Status

The API, the staff front-desk client (`/`) and the customer self-service portal (`/portal`) are working. Customers browse availability, register, book hourly or whole-day slots, and manage their own reservations; staff keep the desk, cash and setup workflows. The currency symbol remains a per-browser setting until the API exposes a shared one.
