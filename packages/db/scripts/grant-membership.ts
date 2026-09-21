/**
 * Grants an existing account access to a tenant, from the command line.
 *
 *   DATABASE_URL_MAINT=... tsx scripts/grant-membership.ts <email> <tenant-slug> <role>
 *
 * The People screen handles everything an admin should be doing themselves:
 * creating an account, and adding one that belongs to nothing. This covers the
 * case it deliberately cannot — an account that belongs to a **different**
 * engagement. That row is another client's roster, and it stays invisible to a
 * Zeeraa admin exactly as it does to a client admin, so moving somebody between
 * engagements is a maintenance operation rather than a button.
 *
 * The gate is holding the maintenance connection string, which the application
 * does not have, and which `withMaintenance` needs a role membership to use.
 * The same gate as `set-password.ts`.
 *
 * It does not create accounts and does not set passwords. If the address has no
 * account, this refuses and says so — creating one belongs on the screen where
 * a password is generated and handed over.
 */
import { and, eq } from 'drizzle-orm';
import { getMaintenanceDb, closeConnections } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const ROLES = ['zeeraa_admin', 'zeeraa_member', 'client_admin', 'client_viewer'] as const;
type Role = (typeof ROLES)[number];

const [email, slug, role] = [
  process.argv[2]?.trim().toLowerCase(),
  process.argv[3]?.trim(),
  process.argv[4]?.trim() as Role | undefined,
];

if (!email || !slug || !role || !ROLES.includes(role)) {
  console.error('Usage: tsx scripts/grant-membership.ts <email> <tenant-slug> <role>');
  console.error(`  role is one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

try {
  const result = await withMaintenance(getMaintenanceDb(), async (tx) => {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) return { error: `No account with the address ${email}.` } as const;

    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) return { error: `No tenant with the slug ${slug}.` } as const;

    const existing = await tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, user.id),
          eq(schema.memberships.tenantId, tenant.id),
        ),
      );

    await tx
      .insert(schema.memberships)
      .values({ userId: user.id, tenantId: tenant.id, role })
      .onConflictDoUpdate({
        target: [schema.memberships.userId, schema.memberships.tenantId],
        set: { role },
      });

    return { tenant: tenant.name, previous: existing[0]?.role ?? null } as const;
  });

  if ('error' in result) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(
    result.previous
      ? `${email} in ${result.tenant}: ${result.previous} → ${role}.`
      : `${email} now has ${role} access to ${result.tenant}.`,
  );
  // Sessions are untouched on purpose. Access is read from `memberships` on
  // every request, so this takes effect immediately without ending one.
} finally {
  await closeConnections();
}
