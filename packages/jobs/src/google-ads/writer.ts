import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@zeeraa/db';
import type { CampaignRow, ClickRow, DailyMetricRow } from '@zeeraa/connectors';
import type { GoogleAdsAccount } from '@zeeraa/connectors';

/**
 * Writing ad-platform data into Postgres.
 *
 * Everything upserts. The nightly job re-pulls a trailing 90-day window because
 * Google restates conversions for 30+ days, so an append would double-count
 * every restatement (§16). The same rule covers clicks: a day that half
 * succeeded is re-run, and re-running has to converge rather than duplicate.
 *
 * Every function takes the transaction handle from `withJobTenant`, so the
 * tenant is established by the database rather than by a `where` clause
 * somebody has to remember.
 */

export async function upsertAdAccount(
  tx: Database,
  tenantId: string,
  platform: string,
  account: GoogleAdsAccount,
): Promise<string> {
  const [row] = await tx
    .insert(schema.adAccounts)
    .values({
      tenantId,
      platform,
      externalAccountId: account.externalAccountId,
      name: account.name,
      accountTimezone: account.timeZone,
      currency: account.currency,
    })
    .onConflictDoUpdate({
      target: [
        schema.adAccounts.tenantId,
        schema.adAccounts.platform,
        schema.adAccounts.externalAccountId,
      ],
      set: {
        name: sql`excluded.name`,
        // Re-read every sync. An account whose reporting zone changes silently
        // re-buckets every future day, and the mismatch check is what surfaces
        // it — so this value must not go stale.
        accountTimezone: sql`excluded.account_timezone`,
        currency: sql`excluded.currency`,
      },
    })
    .returning({ id: schema.adAccounts.id });
  return row!.id;
}

/**
 * Upserts campaigns and returns the external → internal id map.
 *
 * The map is the point. `daily_metrics` and `ad_clicks` both key on the
 * internal uuid, and resolving it per row would be one query per row.
 */
export async function upsertCampaigns(
  tx: Database,
  tenantId: string,
  platform: string,
  rows: readonly CampaignRow[],
  adAccountId?: string,
): Promise<Map<string, string>> {
  if (rows.length > 0) {
    await tx
      .insert(schema.campaigns)
      .values(
        rows.map((row) => ({
          tenantId,
          platform,
          adAccountId: adAccountId ?? null,
          externalCampaignId: row.externalCampaignId,
          name: row.name,
          status: row.status ?? null,
          campaignType: row.campaignType ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.campaigns.tenantId,
          schema.campaigns.platform,
          schema.campaigns.externalCampaignId,
        ],
        set: {
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          campaignType: sql`excluded.campaign_type`,
          adAccountId: sql`excluded.ad_account_id`,
          // product, industry and keyword_tier are deliberately absent: they are
          // Zeeraa's own classification of a campaign, not the platform's, and a
          // sync must never overwrite a human's categorisation with a null.
        },
      });
  }
  return campaignIdMap(tx, tenantId, platform);
}

export async function campaignIdMap(
  tx: Database,
  tenantId: string,
  platform: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      id: schema.campaigns.id,
      externalCampaignId: schema.campaigns.externalCampaignId,
    })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.tenantId, tenantId), eq(schema.campaigns.platform, platform)));
  return new Map(rows.map((r) => [r.externalCampaignId, r.id]));
}

/**
 * Daily spend.
 *
 * A row whose campaign is not in the map is written against a null campaign
 * rather than dropped: the spend happened and belongs in the account total,
 * and dropping it would make the platform disagree with Google's own UI. The
 * unique index coalesces the null so those rows still deduplicate.
 */
export async function upsertDailyMetrics(
  tx: Database,
  tenantId: string,
  platform: string,
  rows: readonly DailyMetricRow[],
  campaigns: Map<string, string>,
  syncRunId: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  // Written as parameterised SQL rather than through the query builder, because
  // the unique index is on an expression — `coalesce(campaign_id, <zero uuid>)`
  // — so that account-level rows, whose campaign is null, still deduplicate.
  // Drizzle's `onConflictDoUpdate` takes columns, not expressions, and naming
  // the plain columns here would silently target a constraint that does not
  // exist and turn every re-pull into an append.
  const byKey = new Map<string, { row: DailyMetricRow; campaignId: string | null }>();
  for (const row of rows) {
    const campaignId = row.externalCampaignId
      ? (campaigns.get(row.externalCampaignId) ?? null)
      : null;
    // Postgres refuses an ON CONFLICT that hits the same row twice within one
    // statement, so a duplicate key inside the batch is collapsed here.
    byKey.set(`${row.date}|${campaignId ?? ''}`, { row, campaignId });
  }

  const values = [...byKey.values()].map(
    ({ row, campaignId }) => sql`(
      ${tenantId}::uuid,
      ${platform},
      ${row.date}::date,
      ${campaignId}::uuid,
      ${String(Math.round(row.impressions))}::numeric,
      ${String(Math.round(row.clicks))}::numeric,
      ${row.spend.toFixed(4)}::numeric,
      ${row.platformConversions.toFixed(4)}::numeric,
      ${row.reach === undefined ? null : String(Math.round(row.reach))}::numeric,
      ${row.allClicks === undefined ? null : String(Math.round(row.allClicks))}::numeric,
      ${syncRunId}::uuid,
      now()
    )`,
  );

  const written = await tx.execute<{ id: string }>(sql`
    INSERT INTO daily_metrics (
      tenant_id, platform, date, campaign_id,
      impressions, clicks, spend, platform_conversions,
      reach, clicks_all,
      sync_run_id, updated_at
    )
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (
      tenant_id, platform, date,
      coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    DO UPDATE SET
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      spend = excluded.spend,
      platform_conversions = excluded.platform_conversions,
      -- Null means "this platform does not report it", so a platform that does
      -- not must not blank a value another pass wrote. Coalesced rather than
      -- assigned: a re-pull of Google Ads days can never erase Meta's reach.
      reach = coalesce(excluded.reach, daily_metrics.reach),
      clicks_all = coalesce(excluded.clicks_all, daily_metrics.clicks_all),
      sync_run_id = excluded.sync_run_id,
      updated_at = excluded.updated_at
    RETURNING id
  `);

  return Array.isArray(written) ? written.length : (written as { length?: number }).length ?? 0;
}

/**
 * Clicks, keyed by click id.
 *
 * Idempotent per day by construction: the upsert key is the click id, so
 * re-running a day that half succeeded converges on the same rows. That is what
 * makes the 90-day backfill safe to resume at any point.
 */
export async function upsertAdClicks(
  tx: Database,
  tenantId: string,
  platform: string,
  rows: readonly ClickRow[],
  campaigns: Map<string, string>,
  syncRunId: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  // A single day can legitimately return the same gclid twice — the same click
  // segmented two ways. Postgres refuses an ON CONFLICT that hits one row twice
  // in a statement, so they are collapsed here rather than by the database.
  const byClickId = new Map<string, ClickRow>();
  for (const row of rows) byClickId.set(row.clickId, row);

  const written = await tx
    .insert(schema.adClicks)
    .values(
      [...byClickId.values()].map((row) => ({
        tenantId,
        platform,
        clickId: row.clickId,
        reportedDate: row.reportedDate,
        campaignId: row.externalCampaignId
          ? (campaigns.get(row.externalCampaignId) ?? null)
          : null,
        externalAdGroupId: row.externalAdGroupId,
        adNetworkType: row.adNetworkType,
        device: row.device,
        syncRunId,
        updatedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [schema.adClicks.tenantId, schema.adClicks.platform, schema.adClicks.clickId],
      set: {
        reportedDate: sql`excluded.reported_date`,
        campaignId: sql`excluded.campaign_id`,
        externalAdGroupId: sql`excluded.external_ad_group_id`,
        adNetworkType: sql`excluded.ad_network_type`,
        device: sql`excluded.device`,
        syncRunId: sql`excluded.sync_run_id`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({ id: schema.adClicks.id });

  return written.length;
}

/** Clicks already held locally, for the join. */
export async function clicksByClickId(
  tx: Database,
  tenantId: string,
  clickIds: readonly string[],
): Promise<Map<string, { platform: string; campaignId: string | null; reportedDate: string }>> {
  if (clickIds.length === 0) return new Map();
  const rows = await tx
    .select({
      clickId: schema.adClicks.clickId,
      platform: schema.adClicks.platform,
      campaignId: schema.adClicks.campaignId,
      reportedDate: schema.adClicks.reportedDate,
    })
    .from(schema.adClicks)
    .where(and(eq(schema.adClicks.tenantId, tenantId), inArray(schema.adClicks.clickId, [...clickIds])));

  return new Map(
    rows.map((r) => [
      r.clickId,
      { platform: r.platform, campaignId: r.campaignId, reportedDate: r.reportedDate },
    ]),
  );
}
