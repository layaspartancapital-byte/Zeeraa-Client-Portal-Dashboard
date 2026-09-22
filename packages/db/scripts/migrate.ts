import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Migrations run as zeeraa_owner, not as an administrative superuser, so that
// FORCE ROW LEVEL SECURITY binds here exactly as it does in production.
const url = process.env.DATABASE_URL_OWNER;
if (!url) throw new Error('DATABASE_URL_OWNER is not set. Run bootstrap first.');

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  /**
   * Assume `zeeraa_owner` before anything is created.
   *
   * **A created object belongs to whoever created it**, and on a managed
   * provider the connection available is usually the provider's own
   * administrative role — Neon's `neondb_owner`, which carries BYPASSRLS. That
   * role is a *member* of `zeeraa_owner`, so every statement in every migration
   * succeeds and the mistake is invisible: the migration reports success and
   * the object lands owned by a role that can bypass row level security.
   *
   * It has happened three times. `app.enforce_asset_review_authority` in 0013,
   * `app.holds_any_membership` in 0019, and — found on 22 September 2026, long
   * after a preflight check was added for functions — the `calls`,
   * `submissions` and `engagement_targets` *tables*, from 0011, 0012 and 0020.
   *
   * `SET ROLE` fixes it at the source and needs no second connection string.
   * The documented alternative was a real `DATABASE_URL_OWNER` for the hosted
   * database, which has never materialised; a `role` startup parameter was
   * tried and did not take. This does, because `max: 1` means drizzle's
   * migrator runs on this same session.
   *
   * Local is unaffected: the connection there is already `zeeraa_owner`, and
   * assuming a role you already hold is a no-op.
   *
   * Deliberately fatal when it fails. A migration that proceeds as the wrong
   * role is the thing this exists to prevent, so a database where the role is
   * missing or unreachable must stop here rather than quietly carry on and
   * misown whatever it creates.
   */
  const whoAmI = async () => {
    const rows = await sql<{ current_user: string }[]>`select current_user`;
    if (!rows[0]) throw new Error('The database did not answer `select current_user`.');
    return rows[0].current_user;
  };

  const before = await whoAmI();
  try {
    await sql.unsafe('set role zeeraa_owner');
  } catch (error) {
    throw new Error(
      `Could not assume zeeraa_owner as ${before}: ${(error as Error).message}. ` +
        'Migrations must create objects as zeeraa_owner — an object owned by a ' +
        'BYPASSRLS role is what preflight refuses to deploy against. Grant ' +
        'membership with: GRANT zeeraa_owner TO <role>;',
    );
  }
  const after = await whoAmI();
  if (after !== 'zeeraa_owner') {
    throw new Error(`Expected to be zeeraa_owner after SET ROLE, still ${after}.`);
  }
  if (before !== after) console.log(`Assumed zeeraa_owner (connected as ${before})`);

  console.log('Running migrations');
  await migrate(drizzle(sql), { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  console.log('Migrations complete');
} finally {
  await sql.end();
}
