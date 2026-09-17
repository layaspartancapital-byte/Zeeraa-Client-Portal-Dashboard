/**
 * Mints a database session for a seeded user so local work does not depend on
 * an email provider being configured. Prints the cookie value.
 *
 *   pnpm --filter @zeeraa/db exec tsx scripts/dev-session.ts admin@zeeraa.com
 *
 * Refuses to run against a hosted database: this bypasses sign-in entirely.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL_OWNER is not set.');
if (!/localhost|127\.0\.0\.1/.test(url)) {
  throw new Error('dev-session only runs against a local database.');
}

const email = process.argv[2];
if (!email) throw new Error('Usage: tsx scripts/dev-session.ts <email>');

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.maintenance', 'on', true)`;
    const [user] = await tx<{ id: string }[]>`select id from users where email = ${email}`;
    if (!user) throw new Error(`No user with email ${email}. Run the seed with SEED_USERS=yes.`);
    const token = `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await tx`
      insert into sessions (session_token, user_id, expires)
      values (${token}, ${user.id}, now() + interval '7 days')
    `;
    console.log(token);
  });
} finally {
  await sql.end();
}
