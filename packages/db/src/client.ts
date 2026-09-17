import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = PostgresJsDatabase<typeof schema>;

function connect(url: string, max: number) {
  return postgres(url, {
    max,
    // Tenant context is set per transaction with `set_config(..., true)`, so a
    // pooled connection can never carry one request's tenant into the next.
    prepare: false,
    onnotice: () => {},
  });
}

let appSql: ReturnType<typeof postgres> | undefined;
let appDb: Database | undefined;

/**
 * The runtime connection.
 *
 * Connects as `zeeraa_app`, a NOBYPASSRLS non-owner role. Row level security
 * therefore applies to every statement this handle issues — including the ones
 * where somebody forgot the `where tenant_id = ?` clause.
 *
 * Nothing in the application may use the owner connection (§5).
 */
export function getDb(): Database {
  if (!appDb) {
    const url = process.env.DATABASE_URL_APP;
    if (!url) {
      throw new Error(
        'DATABASE_URL_APP is not set. The application must connect as the ' +
          'RLS-constrained role, never as the database owner.',
      );
    }
    appSql = connect(url, 10);
    appDb = drizzle(appSql, { schema });
  }
  return appDb;
}

/**
 * Owner connection. Migrations and seeds only.
 *
 * `zeeraa_owner` is NOSUPERUSER and NOBYPASSRLS, and FORCE ROW LEVEL SECURITY
 * binds it, so this handle reads nothing on its own — every statement against a
 * tenant table has to go through `withMaintenance`.
 */
export function getOwnerDb(): { db: Database; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set. Run bootstrap first.');
  const sql = connect(url, 1);
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

/**
 * A separate handle for the Auth.js adapter.
 *
 * Sign-in writes to `users`, `accounts` and `sessions` before any tenant
 * context exists, so those tables carry policies targeted at the `zeeraa_auth`
 * role. That role has no access to any tenant-scoped table.
 */
let authSql: ReturnType<typeof postgres> | undefined;
let authDb: Database | undefined;

export function getAuthDb(): Database {
  if (!authDb) {
    const url = process.env.DATABASE_URL_AUTH;
    if (!url) {
      throw new Error(
        'DATABASE_URL_AUTH is not set. Sign-in runs on the zeeraa_auth role; ' +
          'falling back to the application role would fail at the first policy.',
      );
    }
    authSql = connect(url, 5);
    authDb = drizzle(authSql, { schema });
  }
  return authDb;
}

export async function closeConnections(): Promise<void> {
  await Promise.all([appSql?.end(), authSql?.end()]);
  appSql = undefined;
  appDb = undefined;
  authSql = undefined;
  authDb = undefined;
}

export { schema };
