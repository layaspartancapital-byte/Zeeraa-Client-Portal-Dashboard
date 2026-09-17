/**
 * Creates the database roles. Idempotent; run once per database (and once per
 * Neon branch) before the first migration.
 *
 * Connects as an administrative role (DATABASE_URL). Nothing else does.
 *
 *   zeeraa_owner        owns the schema. Migrations and seeds run as this role.
 *                       NOSUPERUSER and NOBYPASSRLS, so FORCE ROW LEVEL
 *                       SECURITY genuinely binds it — which is the whole point
 *                       of FORCE, and is why local development does not run
 *                       migrations as `postgres`.
 *   zeeraa_app          the runtime role. No membership of zeeraa_maintenance.
 *   zeeraa_auth         the Auth.js adapter. Identity tables only.
 *   zeeraa_maintenance  NOLOGIN. Membership enables the maintenance policies,
 *                       but only in a transaction that sets app.maintenance.
 *   zeeraa_maint        LOGIN. The role a backfill script or a psql session
 *                       should use. Member of zeeraa_maintenance.
 *
 * On a managed Postgres where you cannot create the owner, grant the existing
 * owner membership of zeeraa_maintenance instead and point DATABASE_URL_OWNER
 * at it.
 */
import postgres from 'postgres';

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error('DATABASE_URL is not set.');

const passwords = {
  zeeraa_owner: process.env.OWNER_ROLE_PASSWORD ?? 'zeeraa_owner',
  zeeraa_app: process.env.APP_ROLE_PASSWORD ?? 'zeeraa_app',
  zeeraa_auth: process.env.AUTH_ROLE_PASSWORD ?? 'zeeraa_auth',
  zeeraa_maint: process.env.MAINT_ROLE_PASSWORD ?? 'zeeraa_maint',
};

const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

async function ensureLoginRole(name: keyof typeof passwords) {
  const [existing] = await sql`select 1 from pg_roles where rolname = ${name}`;
  const clause = `login nosuperuser nobypassrls password '${passwords[name]}'`;
  await sql.unsafe(existing ? `alter role ${name} with ${clause}` : `create role ${name} with ${clause}`);
  console.log(`  ${name}: ${existing ? 'updated' : 'created'}`);
}

try {
  console.log('Bootstrapping database roles');

  const [maintenance] = await sql`select 1 from pg_roles where rolname = 'zeeraa_maintenance'`;
  if (!maintenance) await sql.unsafe('create role zeeraa_maintenance nologin');
  console.log(`  zeeraa_maintenance: ${maintenance ? 'present' : 'created'}`);

  await ensureLoginRole('zeeraa_owner');
  await ensureLoginRole('zeeraa_app');
  await ensureLoginRole('zeeraa_auth');
  await ensureLoginRole('zeeraa_maint');

  // Membership of zeeraa_maintenance is necessary but not sufficient: the
  // policies also require app.maintenance to be set on for the transaction.
  await sql.unsafe('grant zeeraa_maintenance to zeeraa_owner, zeeraa_maint');
  // Deliberately NOT granted to zeeraa_app or zeeraa_auth. If it ever is, the
  // maintenance policies become reachable from a web request.

  const [row] = await sql<{ current_database: string }[]>`select current_database()`;
  const db = row!.current_database;
  await sql.unsafe(`grant connect on database "${db}" to zeeraa_owner, zeeraa_app, zeeraa_auth, zeeraa_maint`);
  await sql.unsafe(`grant create on database "${db}" to zeeraa_owner`);

  // The SECURITY DEFINER helpers carry `SET app.maintenance = 'on'` so they can
  // read `memberships` while FORCE binds the owner. Attaching a SET clause for a
  // custom parameter needs an explicit grant when the owner is not a superuser —
  // which it deliberately is not. Postgres 15+.
  await sql.unsafe('grant set on parameter app.maintenance to zeeraa_owner');

  // The owner must own the schema in order to create tables in it, and to own
  // the SECURITY DEFINER helper functions.
  await sql.unsafe('alter schema public owner to zeeraa_owner');
  await sql.unsafe('grant usage on schema public to zeeraa_app, zeeraa_auth, zeeraa_maint');

  console.log('Done.');
  console.log('  Migrations and seeds run as zeeraa_owner (DATABASE_URL_OWNER).');
  console.log('  No default privileges are granted: every new table must grant explicitly.');
} finally {
  await sql.end();
}
