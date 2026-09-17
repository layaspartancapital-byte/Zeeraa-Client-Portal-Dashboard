/**
 * Seeds configuration rows. Idempotent — safe to re-run after editing a seed.
 *
 * Development users are created only when SEED_USERS=yes, so a production seed
 * never invents accounts.
 */
import { getOwnerDb } from '../src/client';
import { applyTenantSeed, ensureMembership } from '../seeds/apply';
import { spartan } from '../seeds/spartan';

const { db, close } = getOwnerDb();

try {
  const tenantId = await applyTenantSeed(db, spartan);
  console.log(`Seeded ${spartan.tenant.name} (${tenantId})`);

  if (process.env.SEED_USERS === 'yes') {
    const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@zeeraa.com';
    const clientEmail = process.env.SEED_CLIENT_EMAIL ?? 'ceo@spartancapitalgroup.com';
    await ensureMembership(db, adminEmail, 'Zeeraa Admin', tenantId, 'zeeraa_admin', 'Account director');
    await ensureMembership(db, clientEmail, 'Client Admin', tenantId, 'client_admin', 'Chief executive');
    console.log(`Development users: ${adminEmail} (zeeraa_admin), ${clientEmail} (client_admin)`);
  }
} finally {
  await close();
}
