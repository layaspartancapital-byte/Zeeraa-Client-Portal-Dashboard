/** Drops and recreates the public schema. Local development only. */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set.');
if (/neon\.tech|supabase\.co/.test(url) && process.env.ALLOW_REMOTE_RESET !== 'yes') {
  throw new Error('Refusing to reset a hosted database. Set ALLOW_REMOTE_RESET=yes to override.');
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.unsafe('drop schema if exists public cascade');
  await sql.unsafe('drop schema if exists app cascade');
  await sql.unsafe('drop schema if exists drizzle cascade');
  await sql.unsafe('create schema public');
  console.log('Schema reset.');
} finally {
  await sql.end();
}
