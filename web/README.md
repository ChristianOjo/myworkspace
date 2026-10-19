# Myworkspace front desk

Staff-only web client for the Myworkspace API.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for time and money helpers
npm run build    # type-check and production build
```

- The API address comes from `VITE_API_BASE_URL` (see `.env.example`, default `http://127.0.0.1:3000`).
- The server must list this app's exact origin in `CORS_ORIGINS`, for example `CORS_ORIGINS=http://localhost:5173`.
- The currency symbol is set per browser in the profile menu until the API gains a shared setting.
