import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two single-page applications share one build:
//   index.html  -> staff front-desk app (/ and /staff routes)
//   portal.html -> customer self-service portal (/portal client routes)
// Relative entries resolve against the Vite root (this directory); keep this
// file free of Node built-ins so `tsc --noEmit` passes without @types/node.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        portal: 'portal.html',
      },
    },
  },
});
