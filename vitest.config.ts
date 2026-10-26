// myworkspace/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/globalSetup.ts',
    fileParallelism: false,
    testTimeout: 60000,
	hookTimeout: 60000,
	exclude: ['**/node_modules/**', '**/dist/**', 'web/**'],
  },
});