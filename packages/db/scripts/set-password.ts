/**
 * Sets somebody's password from the command line.
 *
 *   DATABASE_URL_MAINT=... tsx scripts/set-password.ts someone@example.com
 *
 * **This is the bootstrap path, and it exists because of a chicken and egg.**
 * Every other password in this product is set on the People screen by an admin
 * who is signed in — but the first admin has nobody to create them, and after
 * the move from magic links no existing account has a password at all. Without
 * this script the first deploy of password sign-in locks everybody out of an
 * application whose only way back in is to be signed into it.
 *
 * It is deliberately not a web route and not seedable. The gate is holding the
 * maintenance connection string, which the application does not have and which
 * `withMaintenance` requires a role membership to use — the same gate that
 * protects every other cross-tenant operation here.
 *
 * The password is generated rather than accepted as an argument, so it never
 * reaches a shell history file. It is printed once. `must_change_password` is
 * set, so it is spent the first time it is used, and every session the account
 * holds is closed, because a password being set is either a bootstrap or a
 * recovery and both mean the old sessions should not survive.
 */
import { eq } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { Algorithm, hash } from '@node-rs/argon2';
import { generateInitialPassword } from '@zeeraa/core';
import { getMaintenanceDb, closeConnections } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: tsx scripts/set-password.ts <email>');
  process.exit(1);
}

const password = generateInitialPassword((maxExclusive) => randomInt(maxExclusive));
const passwordHash = await hash(password, {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

try {
  const updated = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const rows = await tx
      .update(schema.users)
      .set({ passwordHash, mustChangePassword: true, passwordUpdatedAt: new Date() })
      .where(eq(schema.users.email, email))
      .returning({ id: schema.users.id, email: schema.users.email });

    if (rows.length === 0) return null;

    // Anything obtained under the previous password, or under no password.
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, rows[0]!.id));
    return rows[0]!;
  });

  if (!updated) {
    console.error(`No account with the address ${email}.`);
    console.error('This script sets a password; it does not create accounts.');
    process.exit(1);
  }

  console.log(`Password set for ${updated.email}:\n`);
  console.log(`    ${password}\n`);
  console.log('Give it to them directly. They will be required to change it on');
  console.log('first sign-in, and any sessions they held have been closed.');
} finally {
  await closeConnections();
}
