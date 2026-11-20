import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // A poll waits for a state; without a graphics card the browser draws in software,
          // and on a slow machine a page answers late. A poll still needs the exact state:
          // only one that fails takes longer to say so.
          expect: { poll: { timeout: 5000 } },
          fileParallelism: false,
        },
      },
    ],
  },
});
