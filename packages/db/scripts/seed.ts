/**
 * Seeds configuration rows. Idempotent — safe to re-run after editing a seed.
 *
 * Development users are created only when SEED_USERS=yes, so a production seed
 * never invents accounts.
 */
import { Algorithm, hash } from '@node-rs/argon2';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import { applyTenantSeed, ensureMembership } from '../seeds/apply';
import { spartan } from '../seeds/spartan';

const { db, close } = getOwnerDb();

try {
  await withMaintenance(db, async (tx) => {
    const tenantId = await applyTenantSeed(tx, spartan);
    console.log(`Seeded ${spartan.tenant.name} (${tenantId})`);

    if (process.env.SEED_USERS === 'yes') {
      const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@zeeraa.com';
      const clientEmail = process.env.SEED_CLIENT_EMAIL ?? 'ceo@spartancapitalgroup.com';

      /**
       * A development password, and only ever that.
       *
       * Guarded on the database being local rather than on NODE_ENV, for the
       * same reason the rest of this repository is: NODE_ENV is a variable
       * somebody can get wrong, and the connection string is the thing that
       * actually decides which database receives the row. A hosted database
       * refuses, so `SEED_USERS=yes` against Neon seeds the configuration and
       * no accounts.
       */
      const url = process.env.DATABASE_URL_OWNER ?? '';
      if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
        throw new Error(
          'SEED_USERS=yes only works against a local database. Create production ' +
            'accounts through the People screen, so the password is generated and ' +
            'handed over rather than written in a script.',
        );
      }

      const password = process.env.SEED_PASSWORD ?? 'zeeraa-development-password';
      const passwordHash = await hash(password, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });

      await ensureMembership(tx, adminEmail, 'Zeeraa Admin', tenantId, 'zeeraa_admin', 'Account director', passwordHash);
      await ensureMembership(tx, clientEmail, 'Client Admin', tenantId, 'client_admin', 'Chief executive', passwordHash);
      console.log(`Development users: ${adminEmail} (zeeraa_admin), ${clientEmail} (client_admin)`);
      console.log(`Password for both: ${password} — you will be asked to change it on first sign-in.`);
    }
  });
} finally {
  await close();
}
