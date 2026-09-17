/**
 * Creates the two runtime roles. Idempotent; run once per database (and once
 * per Neon branch) before the first migration.
 *
 * Both roles are NOBYPASSRLS and neither owns any table, which is what makes
 * the policies in 0001_rls_policies.sql binding rather than advisory.
 */
import postgres from 'postgres';

const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) throw new Error('DATABASE_URL is not set.');

const APP_PASSWORD = process.env.APP_ROLE_PASSWORD ?? 'zeeraa_app';
const AUTH_PASSWORD = process.env.AUTH_ROLE_PASSWORD ?? 'zeeraa_auth';

const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });

async function ensureRole(name: string, password: string) {
  const [existing] = await sql`select 1 from pg_roles where rolname = ${name}`;
  if (existing) {
    await sql.unsafe(`alter role ${name} with login nobypassrls password '${password}'`);
    console.log(`  role ${name}: updated`);
  } else {
    await sql.unsafe(`create role ${name} with login nobypassrls password '${password}'`);
    console.log(`  role ${name}: created`);
  }
}

try {
  console.log('Bootstrapping database roles');
  await ensureRole('zeeraa_app', APP_PASSWORD);
  await ensureRole('zeeraa_auth', AUTH_PASSWORD);

  const [row] = await sql<{ current_database: string }[]>`select current_database()`;
  const db = row!.current_database;
  await sql.unsafe(`grant connect on database "${db}" to zeeraa_app, zeeraa_auth`);
  await sql.unsafe(`grant usage on schema public to zeeraa_app, zeeraa_auth`);

  // A table added by a later migration without an explicit grant should be
  // unreachable, not accidentally world-readable — so no default privileges are
  // granted here on purpose. Every new tenant table must opt in.
  console.log('Done. Roles hold no default privileges; new tables must grant explicitly.');
} finally {
  await sql.end();
}
