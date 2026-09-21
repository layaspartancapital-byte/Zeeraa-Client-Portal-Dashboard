import { sql } from 'drizzle-orm';
import { getDb, type Database } from './client';
import { assertTransactionLocalContext } from './assert-context';

let verified = false;

/**
 * Refuses to serve if the runtime connection could bypass row level security.
 *
 * This is the guard that replaces FORCE ROW LEVEL SECURITY. The failure it
 * catches — the app pointed at the owner connection string, or a role granted
 * BYPASSRLS during an incident and never revoked — is otherwise invisible:
 * everything keeps working, and tenant isolation is simply gone.
 */
export async function assertRlsEnforced(database?: Database): Promise<void> {
  // Memoised only for the shared runtime handle; an explicitly passed handle is
  // always re-checked, which is what lets the test exercise both outcomes.
  if (!database && verified) return;
  const db = database ?? getDb();

  const rows = await db.execute<{
    role: string;
    bypassrls: boolean;
    superuser: boolean;
    unprotected: string[] | null;
  }>(sql`
    select
      current_user as role,
      (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls,
      (select rolsuper from pg_roles where rolname = current_user) as superuser,
      (
        select array_agg(c.relname order by c.relname)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relrowsecurity = false
          and c.relname not in ('__drizzle_migrations')
      ) as unprotected
  `);

  const row = rows[0];
  if (!row) throw new Error('Could not verify row level security state.');

  if (row.bypassrls || row.superuser) {
    throw new Error(
      `Refusing to start: the runtime role "${row.role}" can bypass row level ` +
        'security. Point DATABASE_URL_APP at the zeeraa_app role, not the ' +
        'database owner.',
    );
  }

  if (row.unprotected && row.unprotected.length > 0) {
    throw new Error(
      `Refusing to start: row level security is not enabled on ${row.unprotected.join(', ')}. ` +
        'Every table in public must carry a policy before it can hold tenant data.',
    );
  }

  if (!database) verified = true;
}

/**
 * Every precondition the isolation model depends on, checked against the live
 * connection before anything is served. Both checks are cheap and run once per
 * process; both refuse rather than degrade.
 */
export async function assertDatabaseSafe(): Promise<void> {
  await assertRlsEnforced();
  await assertTransactionLocalContext();
}

/**
 * Refuses if any `app.*` SECURITY DEFINER function is owned by a role that can
 * bypass row level security.
 *
 * A definer function runs with its owner's privileges. These are the functions
 * the policies themselves call, so one owned by a `BYPASSRLS` role is a policy
 * helper that can read past the policies it is helping to evaluate — invisible
 * from the outside, because it keeps returning the right answers until the day
 * somebody edits the body.
 *
 * This is not hypothetical here. Migrations on the hosted database run as
 * `neondb_owner` — a member of `zeeraa_owner`, so the DDL succeeds, and a table
 * created that way carries the right owner while a function does not. It
 * happened to `app.enforce_asset_review_authority()` in 0013 and again to
 * `app.holds_any_membership()` in 0019, both caught by hand after the fact.
 * A note in `docs/state.md` did not stop the second one; this does, because it
 * runs in the deploy.
 *
 * Deliberately separate from `assertDatabaseSafe`: this is a property of the
 * schema rather than of the serving connection, it needs to read `pg_proc`, and
 * the right moment to fail is the deploy rather than the first request.
 */
export async function assertDefinerFunctionsSafelyOwned(database?: Database): Promise<void> {
  const db = database ?? getDb();

  const rows = await db.execute<{ name: string; owner: string }>(sql`
    select p.proname as name, pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'app'
      and p.prosecdef
      and (r.rolbypassrls or r.rolsuper)
    order by p.proname
  `);

  if (rows.length > 0) {
    const named = rows.map((r) => `app.${r.name} (owned by ${r.owner})`).join(', ');
    throw new Error(
      `Refusing to deploy: ${named} ${rows.length === 1 ? 'is a' : 'are'} SECURITY ` +
        'DEFINER function owned by a role that can bypass row level security. ' +
        'Re-own with: ALTER FUNCTION app.<name>(<args>) OWNER TO zeeraa_owner; ' +
        'and run migrations as zeeraa_owner (DATABASE_URL_OWNER) so it does not recur.',
    );
  }
}
