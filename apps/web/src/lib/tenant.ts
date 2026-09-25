import { cache } from 'react';
import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { parseBusinessHours, type BusinessHours, type Role } from '@zeeraa/core';
import {
  assertDatabaseSafe,
  schema,
  withTenant,
  withUserOnly,
  type Database,
  type TenantContext,
} from '@zeeraa/db';
import { readSession } from '@/lib/session';

export type TenantSummary = {
  id: string;
  name: string;
  slug: string;
  accentColor: string;
  timezone: string;
  currency: string;
  role: Role;
};

export type Viewer = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  /** True until they replace the password an admin set for them. */
  mustChangePassword: boolean;
  tenants: TenantSummary[];
};

/**
 * The signed-in person and every tenant they belong to.
 *
 * Read with only a user set, so this query cannot reach tenant data — the
 * `memberships` and `tenants` policies admit a user's own rows and nothing
 * else. This is what populates the switcher.
 *
 * `cache` deduplicates it across a single render pass; it is one round trip per
 * request, not one per component.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await readSession();
  if (!session) return null;
  const { userId } = session;

  // Refuses to serve if the runtime role could bypass row level security, or
  // if transaction-local settings do not hold on this connection — tenant
  // context is carried that way, so a statement-mode pooler would disable
  // isolation silently. Verified once per process, on the first request.
  await assertDatabaseSafe();

  const rows = await withUserOnly(userId, (tx) =>
    tx
      .select({
        id: schema.tenants.id,
        name: schema.tenants.name,
        slug: schema.tenants.slug,
        accentColor: schema.tenants.accentColor,
        timezone: schema.tenants.timezone,
        currency: schema.tenants.currency,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
      .where(eq(schema.memberships.userId, userId))
      .orderBy(asc(schema.tenants.name)),
  );

  return {
    userId,
    email: session.email,
    name: session.name,
    image: session.image,
    mustChangePassword: session.mustChangePassword,
    tenants: rows,
  };
});

export type TenantSession = { viewer: Viewer; tenant: TenantSummary; context: TenantContext };

/**
 * Resolves the tenant named in the URL and checks the viewer belongs to it.
 *
 * The check here is a courtesy that produces a decent error page. It is not the
 * security boundary — that is the row level security policy, which would return
 * nothing even if this function were deleted.
 */
export async function requireTenant(slug: string): Promise<TenantSession> {
  const viewer = await getViewer();
  if (!viewer) redirect(`/signin?next=${encodeURIComponent(`/${slug}`)}`);
  // Before the membership check, deliberately: somebody holding a password an
  // admin read out over the phone should be replacing it whether or not they
  // have been granted a tenant yet.
  if (viewer.mustChangePassword) redirect('/change-password');
  if (viewer.tenants.length === 0) redirect('/no-access');

  const tenant = viewer.tenants.find((t) => t.slug === slug);
  if (!tenant) {
    // Land on a tenant they do have rather than on a dead end.
    redirect(`/${viewer.tenants[0]!.slug}`);
  }

  return {
    viewer,
    tenant,
    context: { tenantId: tenant.id, userId: viewer.userId, role: tenant.role },
  };
}

/**
 * Guards a route that only some roles may open.
 *
 * Hiding a link in the navigation is presentation, not access control — the URL
 * is still typeable, and a client admin reaching the reconciliation screen would
 * see Zeeraa's own unresolved figures. Pages assert their audience here.
 */
export async function requireRole(
  slug: string,
  permitted: (role: Role) => boolean,
): Promise<TenantSession> {
  const session = await requireTenant(slug);
  if (!permitted(session.tenant.role)) redirect(`/${slug}`);
  return session;
}

/** Runs a query inside the tenant's row level security context. */
export function queryTenant<T>(
  session: TenantSession,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return withTenant(session.context, fn);
}

/** Where a signed-in person with no tenant in the URL should land. */
export async function defaultTenantSlug(): Promise<string | null> {
  const viewer = await getViewer();
  return viewer?.tenants[0]?.slug ?? null;
}

/** The tenant's own people plus the Zeeraa staff assigned to it. */
export function tenantRoster(session: TenantSession) {
  return queryTenant(session, (tx) =>
    tx
      .select({
        userId: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        title: schema.users.title,
        image: schema.users.image,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.tenantId, session.tenant.id))
      .orderBy(asc(schema.users.name)),
  );
}

/**
 * The current tenant's logo and square mark, each null for the fallback: the
 * tenant's name as text beside the monogram, and the monogram collapsed.
 *
 * Read separately from `getViewer` on purpose: the viewer query returns every
 * tenant the person belongs to, for the switcher, and carrying each one's
 * image with it would ship every client's logo on every request to render one.
 * Under the tenant's own context, so the `tenants` policy decides who sees it.
 */
export async function tenantLogo(
  session: TenantSession,
): Promise<{ logo: string | null; mark: string | null }> {
  const [row] = await queryTenant(session, (tx) =>
    tx
      .select({ logo: schema.tenants.logoDataUrl, mark: schema.tenants.markDataUrl })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, session.tenant.id)),
  );
  return { logo: row?.logo ?? null, mark: row?.mark ?? null };
}

/**
 * The desk's hours (`lead_response_hours`), or null for the 24/7 clock.
 *
 * Read for `AutoRefresh`, which refreshes on the Salesforce cadence — every
 * ten minutes while the desk is open, hourly otherwise — and so has to know
 * the same hours the Salesforce cron does.
 */
export async function tenantBusinessHours(session: TenantSession): Promise<BusinessHours | null> {
  const [row] = await queryTenant(session, (tx) =>
    tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(
        and(
          eq(schema.tenantConfig.tenantId, session.tenant.id),
          eq(schema.tenantConfig.key, 'lead_response_hours'),
        ),
      )
      .limit(1),
  );
  return parseBusinessHours(row?.value);
}
