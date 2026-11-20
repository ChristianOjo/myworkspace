# Myworkspace web clients

Two React + Vite clients share this directory and build into one `dist/` folder:

| Entry | Route | Audience |
|---|---|---|
| `index.html` (`src/main.tsx`) | `/` | Staff front desk: calendar, cash, setup |
| `portal.html` (`src/portal/main.tsx`) | `/portal` | Customers: browse spaces, book, manage own bookings |

```bash
npm install
npm run dev      # staff app on http://localhost:5173; portal at http://localhost:5173/portal.html
npm test         # unit tests for time and money helpers
npm run build    # type-check both clients and production build (index.html + portal.html)
```

- The API address comes from `VITE_API_BASE_URL` (see `.env.example`, default `http://127.0.0.1:3000`); in production the API serves both clients from the same origin.
- The server must list this app's exact origin in `CORS_ORIGINS`, for example `CORS_ORIGINS=http://localhost:5173`.
- `VITE_DEFAULT_ORG_SLUG` optionally pre-fills the organisation slug on the portal sign-in/register form.
- The currency symbol is set per browser in the profile menu until the API gains a shared setting.
