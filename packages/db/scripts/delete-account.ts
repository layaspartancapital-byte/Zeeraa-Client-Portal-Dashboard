/**
 * Deletes an account outright.
 *
 *   DATABASE_URL_MAINT=... tsx scripts/delete-account.ts <email>
 *
 * The People screen removes *access* — a membership — and deliberately leaves
 * the account, because it may hold other engagements and because the history it
 * is attached to should survive somebody leaving one client. This is the other
 * thing: the account itself, gone. It exists for the case that has no other
 * answer — an address created by a typo, which nobody can sign in as and which
 * occupies a global unique index so the correct address cannot reuse it.
 *
 * **It refuses while the account holds any membership.** Deleting somebody who
 * currently has access would be a revocation with no record that it happened,
 * and a cascade through `memberships` is a silent way to do it. Remove their
 * access on the People screen first, deliberately, and then come here.
 *
 * Irreversible. It prints the row first, so what it removed is at least in the
 * operator's scrollback if the wrong address was typed.
 */
import { eq } from 'drizzle-orm';
import { getMaintenanceDb, closeConnections } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: tsx scripts/delete-account.ts <email>');
  process.exit(1);
}

try {
  const result = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [user] = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        title: schema.users.title,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) return { error: `No account with the address ${email}.` } as const;

    const memberships = await tx
      .select({ tenantId: schema.memberships.tenantId, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user.id));

    if (memberships.length > 0) {
      return {
        error:
          `${email} still has access to ${memberships.length} ` +
          `${memberships.length === 1 ? 'engagement' : 'engagements'}. Remove it on the ` +
          'People screen first — deleting the account here would revoke it as a ' +
          'side effect and leave nothing saying so.',
      } as const;
    }

    // `sessions` and `notifications` cascade; `data_sources.recorded_by_user_id`
    // is SET NULL, which loses an attribution rather than a row. Counted so the
    // operator sees it happen instead of discovering it later.
    const [sessions] = await tx
      .select({ n: schema.sessions.sessionToken })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));

    console.log('Deleting:');
    console.log(`  id         ${user.id}`);
    console.log(`  email      ${user.email}`);
    console.log(`  name       ${user.name ?? '—'}`);
    console.log(`  title      ${user.title ?? '—'}`);
    console.log(`  created    ${user.createdAt.toISOString()}`);
    console.log(`  sessions   ${sessions ? 'some (cascade)' : 'none'}`);

    await tx.delete(schema.users).where(eq(schema.users.id, user.id));
    return { deleted: user.email } as const;
  });

  if ('error' in result) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`\n${result.deleted} deleted.`);
} finally {
  await closeConnections();
}
