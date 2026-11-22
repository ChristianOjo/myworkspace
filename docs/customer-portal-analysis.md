# Customer-facing portal — analysis and implementation notes

## 1. Starting point (what the app did before this change)

The codebase was a **staff-only** booking desk:

- **Backend:** Fastify + PostgreSQL, multi-tenant with Row Level Security. Every business route required a Bearer session.
- **Roles (before):** `org_admin`, `location_manager`, `member`. `member` was a junior front-desk staff account, not a customer.
- **Booking creation:** only `POST /bookings` (staff route). The staff member supplied a free-text `customerName` / `customerPhone`; the booking's `user_id` was the staff member, so there was no account owning the reservation.
- **Catalogue reads:** staff-only `GET /locations` and `GET /resources`; no anonymous read path.
- **Money:** cash payments/refunds recorded by staff; no payment provider integration (columns such as `stripe_customer_id` exist but no provider is configured on the free-tier deployment).
- **Frontend:** one React/Vite SPA (`web/index.html`) with Calendar, Cash and Setup views. No registration, no "my bookings", no cancellation by a customer.

Production data observed on `https://myworkspace-8lls.onrender.com` (org slug `mws-desks`): one location "Main" (08:00–20:00, `Africa/Mbabane`), one active dedicated desk with E250.00/hour and E500.00/day rates.

## 2. Gap analysis

| Need for customers | Before | After this change |
|---|---|---|
| See what spaces exist and their prices | Staff login required | Public `/public/:slug/*` catalogue (org, locations, active resources, daily availability) |
| Create an account | Admins created staff only | Public `POST /auth/register` creates a `customer` user with hashed password and optional phone |
| Book a space without staff | Staff filled the form | `POST /me/bookings` for hourly or whole-day slots, owned by the caller |
| See my reservations | Not possible | `GET /me/bookings` and `GET /me/bookings/:id` |
| Cancel a reservation | Managers could cancel/refund desk-side | `POST /me/bookings/:id/cancel` for own confirmed, unpaid, upcoming bookings |
| Separate UI for customers | One staff SPA | Second SPA served at `/portal`; staff app stays at `/` |
| Stop customers using staff screens | Single authenticated group | Role guards: staff routes limited to `org_admin`/`location_manager`/`member`; `/me/*` limited to `customer` |

## 3. Scope and design decisions

### In scope
- Anonymous catalogue browsing: active resources only (maintenance/retired hidden), rates, type, capacity, open hours, busy intervals and maintenance blocks for a chosen day.
- Customer registration/sign-in/sign-out, profile phone, own-password change.
- Self-service booking: hourly slots on 15-minute boundaries (server-enforced) or whole-day bookings; same validation, pricing and exclusion-constraint conflict protection as desk bookings.
- Self-service cancellation for unpaid upcoming confirmed bookings.
- Independent customer SPA with browse, booking drawer and "My bookings" list.

### Out of scope (kept as staff responsibilities)
- Online payment gateway. Bookings are confirmed reservations; cash is collected at the desk, consistent with the existing cash flow. Paid or already-started bookings must be cancelled by staff.
- Online check-in ("arrived now") and early release — front-desk operations.
- Customer profile administration, corporate teams/invoices, waivers and emails (no mail provider configured).
- Public marketing pages beyond the booking shell.

### Identity model
- New enum value `customer` added to `user_role` (migration 008). Existing staff roles are unchanged.
- `users.phone` stores the contact number for registered customers; walk-in bookings keep their free-text `bookings.customer_name` / `bookings.customer_phone` columns.
- Sessions reuse the existing hashed-token system; the portal stores its token under a separate `sessionStorage` key so a staff session and a customer session cannot share a token.

### Security model
- Public routes perform no tenant write; they resolve the org via the `org_id_by_slug(slug)` SECURITY DEFINER function and scope reads with the existing `app.org_id` RLS context.
- Registration validates slug, email, name, phone length and a 10–200 character password; duplicate emails return 409; weak passwords return 400.
- The login/registration rate limiter is reused per account/IP.
- Staff routes and customer routes live in separate Fastify registrations with `preHandler` guards; unknown roles receive `403 staff_only` / `403 customer_portal_only`.
- Customer cancel re-checks ownership, status, start time and net paid inside a locked transaction before delegating to the shared cancellation logic (no refunds for self-cancel).

### Data and API
- Migration `008_customer_portal.sql`: adds the `customer` role and `users.phone`; `009_customer_company.sql` adds the optional visitor `users.company` (employer name, distinct from the tenant org); no new tables (existing RLS grants already cover the reads/writes).
- Public API: `GET /public/default-org` (the only active organisation; 404 `unknown_org` when none, `multiple_orgs` when several), `GET /public/:slug/org`, `/locations`, `/resources`, `/availability`.
- Customer API: `POST /auth/register`, `GET/POST /me/bookings`, `GET /me/bookings/:id`, `POST /me/bookings/:id/cancel`.
- New audit action `customer_booking.create`; registration writes `customer.register`; cancellations keep `booking.cancel`.

### Frontend
- Vite multi-entry build emits `index.html` (staff) and `portal.html` (customer); `static.ts` maps `/portal` and `/portal/*` to `portal.html`, while every other client route falls back to the staff app.
- The portal reuses the shared design system (`global.css`), drawer, feedback and money/date helpers, with portal-only styles in `web/src/portal/portal.css`.
- The customer never has to know the organisation slug: the portal calls `/public/default-org` and hides the slug field for the single deployed workspace; `VITE_DEFAULT_ORG_SLUG` can pin it at build time instead. Manual slug entry remains as the fallback for multi-workspace deployments or when the lookup fails. The register/login API still sends `orgSlug` because accounts are tenant-scoped (`users.org_id NOT NULL`, RLS).

## 4. Verification performed

- Backend `tsc` production build (`npm run build`) clean; frontend `tsc --noEmit && vite build` clean; web helper unit tests pass (6/6).
- New API tests in `test/customer-portal.test.ts` cover registration validation and duplicate email, public catalogue shape, hourly/day customer booking, listing and detail, ownership isolation, conflict rejection, paid/started cancel guards, and cross-role 403/401 guards. (The API suite requires the local Postgres test database; it was not executed in this environment because no Postgres/Docker is available here.)
- Existing staff behaviour was preserved: staff routes still accept the three staff roles; existing desk booking, cash and setup flows were not moved.

## 5. Follow-up suggestions

1. Add a payment provider (or "pay on arrival" invoice number) when the business wants online prepayment.
2. Email confirmations and reminders once an SMTP provider is available.
3. Customer-facing resource photos, descriptions and live seat-level availability.
4. A `customers` admin view for staff to search registered customers and their history.
