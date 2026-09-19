import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@zeeraa/db';
import { platformLabel } from '@/lib/reporting';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * Which ad platforms get a page, and therefore a rail entry.
 *
 * **The test is whether the platform has reported anything, not what its
 * connection status says.** The rail used to filter on `status = 'healthy'`,
 * which is a different question and answers it wrongly in three ways:
 *
 *   - A status is only as fresh as the last `test-connection`. Meta sat at
 *     `not_configured` in production with working credentials and 102 days of
 *     spend behind it, because `set-credentials` deliberately does not promote
 *     a status and nobody had run the test against that database yet. The rail
 *     hid a page that had everything to show.
 *   - `degraded` is a working connection with a stated defect — an ad account
 *     reporting in another timezone still delivers usable data — and hiding its
 *     page would lose ninety days of history over a caveat.
 *   - `waiting_on_client` means the account is paused or a token was revoked.
 *     Whatever stopped, what already landed is still worth reading, and the
 *     page's own status badge is what should say the connector is not currently
 *     pulling.
 *
 * So: a page exists where there is data, and the badge on it tells the truth
 * about the connection. A rail entry stays a promise that the page has
 * something to show — which is what it was always meant to be.
 */

/** Platforms with an ads page. Ordered, so the rail is stable. */
export const AD_PLATFORMS = ['google_ads', 'meta', 'microsoft_ads', 'linkedin_ads'] as const;

export type ReportingPlatform = {
  key: string;
  label: string;
  /** Current connection health, for the badge. Not a filter. */
  status: string;
};

export async function reportingPlatforms(session: TenantSession): Promise<ReportingPlatform[]> {
  return queryTenant(session, async (tx) => {
    const rows = await tx
      .select({
        platform: schema.connections.platform,
        status: schema.connections.status,
      })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, session.tenant.id),
          inArray(schema.connections.platform, [...AD_PLATFORMS]),
          // Reported anything at all, ever. Deliberately not scoped to the
          // window the page happens to be showing: a platform that spent
          // nothing in the last 30 days still has a page, and it renders an
          // empty state rather than disappearing from the rail as the date
          // filter moves.
          sql`exists (
            select 1 from ${schema.dailyMetrics} dm
            where dm.tenant_id = ${schema.connections.tenantId}
              and dm.platform = ${schema.connections.platform}
          )`,
        ),
      )
      .orderBy(asc(schema.connections.platform));

    return rows.map((r) => ({
      key: r.platform,
      label: platformLabel(r.platform),
      status: r.status,
    }));
  });
}
