import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The number checks (`test/numbers`): run against a real database by
 * `pnpm --filter @zeeraa/web numbers`, which the deploy runs after preflight —
 * `buildCommand` in `vercel.json` — so a figure that moved, or two screens
 * that disagree, fails the deployment. Not part of `pnpm test`: they need
 * data, and read through the maintenance role, read-only.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/numbers/**/*.numbers.ts'],
    setupFiles: ['test/numbers/setup.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
