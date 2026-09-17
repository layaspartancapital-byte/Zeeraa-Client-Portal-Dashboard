import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Migrations run as zeeraa_owner, not as an administrative superuser, so that
// FORCE ROW LEVEL SECURITY binds here exactly as it does in production.
const url = process.env.DATABASE_URL_OWNER;
if (!url) throw new Error('DATABASE_URL_OWNER is not set. Run bootstrap first.');

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  console.log('Running migrations');
  await migrate(drizzle(sql), { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  console.log('Migrations complete');
} finally {
  await sql.end();
}
