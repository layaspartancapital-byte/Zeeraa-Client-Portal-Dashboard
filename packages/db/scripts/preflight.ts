/**
 * Fails loudly on a database that cannot enforce tenant isolation.
 *
 * Run this in the deploy pipeline — as part of the Vercel build command, or as
 * a post-deploy step — so that a DATABASE_URL_APP pointing at the owner role or
 * at a statement-mode pooler breaks the deploy. The same checks run on the
 * first request at runtime, but by then the deploy has already gone out.
 *
 *   pnpm --filter @zeeraa/db preflight
 */
import { assertRlsEnforced } from '../src/assert-rls';
import { assertTransactionLocalContext } from '../src/assert-context';
import { closeConnections } from '../src/client';

const checks: [string, () => Promise<void>][] = [
  ['row level security is enforced for the runtime role', () => assertRlsEnforced()],
  ['tenant context is transaction-local on this connection', () => assertTransactionLocalContext()],
];

let failed = false;
try {
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`  ok    ${label}`);
    } catch (error) {
      failed = true;
      console.error(`  FAIL  ${label}`);
      console.error(`        ${(error as Error).message}`);
    }
  }
} finally {
  await closeConnections();
}

if (failed) {
  console.error('\nPreflight failed. Refusing to deploy against this database.');
  process.exit(1);
}
console.log('\nPreflight passed.');
