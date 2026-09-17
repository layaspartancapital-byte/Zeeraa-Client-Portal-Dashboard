import { sql } from 'drizzle-orm';
import { getDb, type Database } from './client';

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
