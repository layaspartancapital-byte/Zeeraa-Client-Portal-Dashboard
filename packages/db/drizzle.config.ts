import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // Policies are hand-written (see migrations/0001_rls.sql) so that the exact
  // USING/WITH CHECK clauses are reviewable in the diff rather than generated.
  verbose: true,
  strict: true,
} satisfies Config;
