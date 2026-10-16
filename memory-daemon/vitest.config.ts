import { defineConfig } from 'vitest/config';

// Two projects: unit runs free; integration runs sequentially because the
// daemon is single-instance per machine (one pipe per test, never two at once).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // forks (processes), not threads: chokidar's fs.watch is not
          // reliable inside worker_threads on Windows.
          pool: 'forks',
          // vitest 4: sequential is via fileParallelism, no longer singleThread.
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
