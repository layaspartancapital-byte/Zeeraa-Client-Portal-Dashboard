import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The `@/` alias, so a unit test can import a module that uses it.
 *
 * Without this, any module reachable from a test that imports `@/lib/...`
 * fails to resolve — including transitively, which is how a test of one pure
 * function ends up failing on a database module it never calls.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
