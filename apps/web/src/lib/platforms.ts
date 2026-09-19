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

/** Paid platforms: spend, campaigns, and an outcomes section. */
export const AD_PLATFORMS = ['google_ads', 'meta', 'microsoft_ads', 'linkedin_ads'] as const;

/**
 * Organic sources: no spend, no campaigns, and no outcomes section, because
 * neither can be attributed to a deal. They get a page on the same rail because
 * a reader asking "how is search doing" should not have to know which of our
 * tables the answer lives in.
 */
export const ORGANIC_PLATFORMS = ['ga4', 'search_console'] as const;

export type PlatformKind = 'ads' | 'organic';

export function platformKind(key: string): PlatformKind | null {
  if ((AD_PLATFORMS as readonly string[]).includes(key)) return 'ads';
  if ((ORGANIC_PLATFORMS as readonly string[]).includes(key)) return 'organic';
  return null;
}

export type ReportingPlatform = {
  key: string;
  label: string;
  kind: PlatformKind;
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
          inArray(schema.connections.platform, [...AD_PLATFORMS, ...ORGANIC_PLATFORMS]),
          // Reported anything at all, ever, into whichever table this source
          // writes. Deliberately not scoped to the window the page happens to
          // be showing: a platform that spent nothing in the last 30 days still
          // has a page, and it renders an empty state rather than disappearing
          // from the rail as the date filter moves.
          sql`(
            exists (
              select 1 from ${schema.dailyMetrics} dm
              where dm.tenant_id = ${schema.connections.tenantId}
                and dm.platform = ${schema.connections.platform}
            )
            or (${schema.connections.platform} = 'ga4' and exists (
              select 1 from ${schema.ga4Metrics} g
              where g.tenant_id = ${schema.connections.tenantId}
            ))
            or (${schema.connections.platform} = 'search_console' and exists (
              select 1 from ${schema.searchConsoleMetrics} sc
              where sc.tenant_id = ${schema.connections.tenantId}
            ))
          )`,
        ),
      )
      .orderBy(asc(schema.connections.platform));

    // Paid first, then organic: the rail reads in the order a reader asks the
    // questions, not alphabetically.
    const order = [...AD_PLATFORMS, ...ORGANIC_PLATFORMS] as readonly string[];
    return rows
      .map((r) => ({
        key: r.platform,
        label: platformLabel(r.platform),
        kind: platformKind(r.platform)!,
        status: r.status,
      }))
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  });
}
