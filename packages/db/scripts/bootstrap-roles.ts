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
  zeeraa_jobs_runner: process.env.JOBS_ROLE_PASSWORD ?? 'zeeraa_jobs_runner',
};

const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

/**
 * A single-quoted SQL literal.
 *
 * Role DDL cannot be parameterised, so the password is interpolated — and a
 * password containing an apostrophe would previously have ended the literal
 * early and executed whatever followed. Quotes are doubled, which is correct
 * under `standard_conforming_strings` (on by default since 9.1), and anything
 * outside the generated alphabet is refused rather than escaped, because a
 * backslash or a newline in role DDL is never something we meant.
 */
function literal(value: string): string {
  if (!/^[A-Za-z0-9!*\-._~]+$/.test(value)) {
    throw new Error(
      'Role passwords must use only letters, digits and !*-._~ — these are ' +
        'interpolated into DDL and into connection URLs, and anything else is ' +
        'either a quoting hazard or needs percent-encoding.',
    );
  }
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureLoginRole(name: keyof typeof passwords) {
  const [existing] = await sql`select 1 from pg_roles where rolname = ${name}`;
  const clause = `login nosuperuser nobypassrls password ${literal(passwords[name])}`;
  await sql.unsafe(existing ? `alter role ${name} with ${clause}` : `create role ${name} with ${clause}`);
  console.log(`  ${name}: ${existing ? 'updated' : 'created'}`);
}

try {
  console.log('Bootstrapping database roles');

  for (const group of ['zeeraa_maintenance', 'zeeraa_jobs']) {
    const [existing] = await sql`select 1 from pg_roles where rolname = ${group}`;
    if (!existing) await sql.unsafe(`create role ${group} nologin`);
    console.log(`  ${group}: ${existing ? 'present' : 'created'}`);
  }

  await ensureLoginRole('zeeraa_owner');
  await ensureLoginRole('zeeraa_app');
  await ensureLoginRole('zeeraa_auth');
  await ensureLoginRole('zeeraa_maint');
  await ensureLoginRole('zeeraa_jobs_runner');

  // Membership of zeeraa_maintenance is necessary but not sufficient: the
  // policies also require app.maintenance to be set on for the transaction.
  await sql.unsafe('grant zeeraa_maintenance to zeeraa_owner, zeeraa_maint');
  // Ingestion connects as zeeraa_jobs_runner. Scoped to a tenant, never to a
  // user, and deliberately not a member of zeeraa_maintenance.
  await sql.unsafe('grant zeeraa_jobs to zeeraa_jobs_runner');
  // Deliberately NOT granted to zeeraa_app or zeeraa_auth. If it ever is, the
  // maintenance policies become reachable from a web request.

  const [row] = await sql<{ current_database: string }[]>`select current_database()`;
  const db = row!.current_database;
  await sql.unsafe(
    `grant connect on database "${db}" to zeeraa_owner, zeeraa_app, zeeraa_auth, zeeraa_maint, zeeraa_jobs_runner`,
  );
  await sql.unsafe(`grant create on database "${db}" to zeeraa_owner`);

  /**
   * Best-effort, and no longer load-bearing.
   *
   * Only a true superuser may grant privileges on a configuration parameter,
   * and a managed Postgres gives you none — Neon's `neon_superuser` is refused
   * with `permission denied for parameter app.maintenance`. The policy helpers
   * therefore no longer carry a `SET app.maintenance` clause; they read
   * `app.membership_index` instead, which needs no elevation at all. See
   * `0002_force_rls.sql`.
   *
   * The grant is still attempted where it is possible, because a session-level
   * `SET app.maintenance` by a maintenance member is unaffected by it either
   * way and a future migration may want the option.
   */
  try {
    await sql.unsafe('grant set on parameter app.maintenance to zeeraa_owner');
    console.log('  app.maintenance: SET granted to zeeraa_owner');
  } catch (error) {
    console.log(
      `  app.maintenance: SET not grantable here (${(error as Error).message.split('\n')[0]}) — not required`,
    );
  }

  /**
   * The owner must own the schema in order to create tables in it, and to own
   * the SECURITY DEFINER helper functions.
   *
   * `ALTER SCHEMA ... OWNER TO` requires the caller to be able to SET ROLE to
   * the new owner. On Postgres 16+ a non-superuser CREATEROLE creator gets
   * `admin_option` on the roles it creates but *not* `set_option`, so this
   * fails on a managed Postgres with "must be able to SET ROLE". Granting the
   * role to ourselves with SET closes that gap; on a cluster where the caller
   * is a superuser it is a harmless no-op.
   */
  await sql
    .unsafe('grant zeeraa_owner to current_user with set true')
    .catch(() => undefined);
  await sql.unsafe('alter schema public owner to zeeraa_owner');
  await sql.unsafe(
    'grant usage on schema public to zeeraa_app, zeeraa_auth, zeeraa_maint, zeeraa_jobs_runner',
  );

  console.log('Done.');
  console.log('  Migrations and seeds run as zeeraa_owner (DATABASE_URL_OWNER).');
  console.log('  No default privileges are granted: every new table must grant explicitly.');
} finally {
  await sql.end();
}
