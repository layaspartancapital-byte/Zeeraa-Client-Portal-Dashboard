import type { CampaignRow, DailyMetricRow } from '../types';
import { checkReportingZone, type ReportingZone } from '../meta/normalize';
import { fromLinkedInDate, urnId } from './client';
import {
  DEFAULT_CONVERSION_METRICS,
  type LinkedInAnalyticsRow,
  type LinkedInCampaignRow,
  type LinkedInConfig,
} from './types';

/**
 * LinkedIn's daily analytics are UTC days (the `dateRange` is "specified in
 * UTC"), and there is no finer grain to re-bucket from. So a LinkedIn day is
 * stored as LinkedIn reports it, and the connection says so — the same rule
 * and the same words as a Meta account set to another zone.
 */
export const LINKEDIN_REPORTING_ZONE = 'UTC';

export function checkLinkedInReportingZone(tenantZone: string): ReportingZone {
  const zone = checkReportingZone(LINKEDIN_REPORTING_ZONE, tenantZone);
  if (zone.aligned) return zone;
  return {
    ...zone,
    detail:
      `LinkedIn reports every day in UTC; this tenant's days are in ${tenantZone}. ` +
      'Daily spend arrives pre-aggregated by the UTC day and LinkedIn offers no ' +
      'finer grain, so spend and CRM events in the hours around midnight fall ' +
      'on different days. Monthly totals are unaffected except at the month edge.',
  };
}

export function normalizeLinkedInCampaigns(rows: readonly LinkedInCampaignRow[], adAccountId: string): CampaignRow[] {
  return rows
    .filter((r) => r.id !== undefined && r.name)
    .map((r) => ({
      externalCampaignId: String(r.id),
      name: r.name!,
      status: r.status,
      externalAccountId: adAccountId,
      // LinkedIn's own word, verbatim: WEBSITE_VISIT, LEAD_GENERATION, …
      campaignType: r.objectiveType ?? r.type,
    }));
}

/**
 * One row per campaign per day. Spend is `costInLocalCurrency`, a decimal
 * string in major units. Conversions sum only the configured LinkedIn counts;
 * `undefined` for a count LinkedIn did not return is "not reported", never 0.
 */
export function normalizeLinkedInDailyMetrics(
  rows: readonly LinkedInAnalyticsRow[],
  config: Pick<LinkedInConfig, 'clickMetric' | 'conversionMetrics'>,
): DailyMetricRow[] {
  const clickMetric = config.clickMetric ?? 'landingPageClicks';
  const conversionMetrics = config.conversionMetrics ?? DEFAULT_CONVERSION_METRICS;
  const out: DailyMetricRow[] = [];
  for (const row of rows) {
    const date = fromLinkedInDate(row.dateRange?.start);
    // The date is part of the upsert key; a row without one cannot land.
    if (!date) continue;
    const spend = Number(row.costInLocalCurrency ?? 0);
    out.push({
      date,
      externalCampaignId: urnId(row.pivotValues?.[0]),
      impressions: row.impressions ?? 0,
      clicks: row[clickMetric] ?? 0,
      spend: Number.isFinite(spend) ? spend : 0,
      platformConversions: conversionMetrics.reduce((sum, m) => sum + (row[m] ?? 0), 0),
      allClicks: row.clicks,
    });
  }
  return out;
}

/**
 * The range in pieces LinkedIn can answer in one response. It caps a
 * response at 15,000 elements and does not paginate analytics; thirty days
 * of campaigns is far inside that for any account this product serves.
 */
export function analyticsChunks(range: { start: string; end: string }, days = 30): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let start = range.start;
  while (start <= range.end) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days - 1);
    const end = d.toISOString().slice(0, 10) < range.end ? d.toISOString().slice(0, 10) : range.end;
    out.push({ start, end });
    const next = new Date(`${end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    start = next.toISOString().slice(0, 10);
  }
  return out;
}
