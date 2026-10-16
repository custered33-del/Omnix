import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/!(web)/test/**/*.test.ts'],
          environment: 'node',
          pool: 'forks',
          // Tests never download the local speech model.
          env: { OMNIX_STT_LOCAL: 'false' },
          testTimeout: 60000,
          hookTimeout: 60000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['packages/web/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['packages/web/test/setup.ts'],
          css: false,
        },
      },
    ],
  },
});
