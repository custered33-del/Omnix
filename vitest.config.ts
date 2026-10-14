import { defineConfig } from 'vitest/config';

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
          testTimeout: 60000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
