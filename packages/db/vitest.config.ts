import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The isolation suite runs against a real Postgres: these guarantees are
    // properties of the database, and a mock would prove nothing.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
