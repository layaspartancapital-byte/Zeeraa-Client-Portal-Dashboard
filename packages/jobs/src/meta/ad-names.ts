import { and, eq, isNotNull, notExists, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@zeeraa/db';
import { landingParameterFor, type LandingParameter } from '@zeeraa/core';
import type { MetaContext } from './context';

const COLUMN: Record<LandingParameter, PgColumn> = {
  utm_term: schema.leads.utmTerm,
  utm_content: schema.leads.utmContent,
  utm_campaign: schema.leads.utmCampaign,
};

/**
 * Names the ads Meta leads arrived from (0041), for the funded-deals list.
 *
 * Which landing-URL parameter carries the ad id is the
 * `landing_url_parameters` row; without one this does nothing. Only ids not
 * yet named are asked about, so after the first run a sync costs one request
 * for however many new ads its leads brought, usually none. Meta answers only
 * for ads in this account, so what is stored is an ad's own name or nothing.
 */
export async function resolveMetaAdNames(
  context: MetaContext,
  runInTenant: <T>(fn: (tx: Database) => Promise<T>) => Promise<T>,
): Promise<number> {
  if (!context.connector.fetchAdNames) return 0;

  const ids = await runInTenant(async (tx) => {
    const [row] = await tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(
        and(
          eq(schema.tenantConfig.tenantId, context.tenantId),
          eq(schema.tenantConfig.key, 'landing_url_parameters'),
        ),
      );
    const param = landingParameterFor(row?.value, 'meta');
    if (!param) return [];
    const column = COLUMN[param];
    const rows = await tx
      .selectDistinct({ id: column })
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.tenantId, context.tenantId),
          eq(schema.leads.channel, 'meta'),
          isNotNull(column),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(schema.platformAds)
              .where(
                and(
                  eq(schema.platformAds.tenantId, context.tenantId),
                  eq(schema.platformAds.platform, 'meta'),
                  eq(schema.platformAds.externalId, column),
                ),
              ),
          ),
        ),
      );
    return rows.map((r) => r.id as unknown).filter((id): id is string => typeof id === 'string' && id.length > 0);
  });
  if (ids.length === 0) return 0;

  const names = await context.connector.fetchAdNames(context.connection, ids);
  if (names.length === 0) return 0;

  return runInTenant(async (tx) => {
    const written = await tx
      .insert(schema.platformAds)
      .values(names.map((n) => ({ tenantId: context.tenantId, platform: 'meta', externalId: n.id, name: n.name })))
      .onConflictDoUpdate({
        target: [schema.platformAds.tenantId, schema.platformAds.platform, schema.platformAds.externalId],
        set: { name: sql`excluded.name`, fetchedAt: sql`now()` },
      })
      .returning({ id: schema.platformAds.externalId });
    return written.length;
  });
}
