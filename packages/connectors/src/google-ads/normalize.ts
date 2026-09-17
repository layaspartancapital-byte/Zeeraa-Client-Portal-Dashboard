import type { DailyMetricRow, CampaignRow } from '../types';
import { MICROS_PER_UNIT, type AdClickRow, type GoogleAdsAccount, type GoogleAdsRow } from './types';

/**
 * Turning GAQL responses into rows.
 *
 * Pure, and tested against captured response shapes rather than a live account.
 * Three things here are easy to get wrong and expensive to get wrong quietly:
 * money arrives in micros, counts arrive as strings, and the date on every row
 * is the *ad account's* calendar day rather than the tenant's.
 */

/**
 * Google returns 64-bit integers as JSON strings — `"1234"` for impressions,
 * `"5230000"` for cost micros — because they do not survive a double. Reading
 * them with `Number()` alone silently produces NaN on an absent field, which
 * then writes as 0 and looks like a real zero.
 */
function count(value: string | number | undefined): number {
  if (value == null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Micros → currency units.
 *
 * Kept at four decimal places to match `daily_metrics.spend`. Dividing by a
 * million can produce more precision than that, and rounding at ingest rather
 * than at render would quietly lose a fraction of a cent per row across a
 * 90-day window.
 */
export function fromMicros(micros: string | number | undefined): number {
  return count(micros) / MICROS_PER_UNIT;
}

export function normalizeAccount(row: GoogleAdsRow): GoogleAdsAccount | null {
  const id = row.customer?.id;
  if (!id) return null;
  return {
    externalAccountId: String(id),
    name: row.customer?.descriptiveName ?? `Account ${id}`,
    currency: row.customer?.currencyCode ?? null,
    timeZone: row.customer?.timeZone ?? null,
  };
}

export function normalizeCampaigns(rows: readonly GoogleAdsRow[]): CampaignRow[] {
  const out: CampaignRow[] = [];
  for (const row of rows) {
    const id = row.campaign?.id;
    if (!id) continue;
    out.push({
      externalCampaignId: String(id),
      name: row.campaign?.name ?? `Campaign ${id}`,
      status: row.campaign?.status,
    });
  }
  return out;
}

/**
 * Daily metrics, one row per campaign per day.
 *
 * A row with no `segments.date` is dropped rather than defaulted: the date is
 * the upsert key, and guessing it would overwrite a real day's spend with
 * another day's.
 */
export function normalizeDailyMetrics(rows: readonly GoogleAdsRow[]): DailyMetricRow[] {
  const out: DailyMetricRow[] = [];
  for (const row of rows) {
    const date = row.segments?.date;
    if (!date) continue;
    out.push({
      date,
      externalCampaignId: row.campaign?.id ? String(row.campaign.id) : null,
      impressions: count(row.metrics?.impressions),
      clicks: count(row.metrics?.clicks),
      spend: fromMicros(row.metrics?.costMicros),
      // Left fractional on purpose. Google returns 622.86 because conversions
      // are attributed fractionally across touchpoints; rounding here would
      // make the platform's own total disagree with Google's UI.
      platformConversions: count(row.metrics?.conversions),
    });
  }
  return out;
}

/**
 * Clicks, from `click_view`.
 *
 * A row without a `gclid` is dropped. That is not defensive coding: Google
 * withholds the gclid on clicks it cannot disclose at click grain, and such a
 * row carries no information the campaign-level spend does not already have.
 * Writing it with an empty click id would collide on the upsert key and
 * overwrite a real click.
 */
export function normalizeClicks(rows: readonly GoogleAdsRow[]): AdClickRow[] {
  const out: AdClickRow[] = [];
  for (const row of rows) {
    const gclid = row.clickView?.gclid?.trim();
    const date = row.segments?.date;
    if (!gclid || !date) continue;
    out.push({
      clickId: gclid,
      reportedDate: date,
      externalCampaignId: row.campaign?.id ? String(row.campaign.id) : null,
      externalAdGroupId: row.adGroup?.id ? String(row.adGroup.id) : null,
      adNetworkType: row.segments?.adNetworkType ?? null,
      device: row.segments?.device ?? null,
    });
  }
  return out;
}

export type ReportingZone =
  | { aligned: true; zone: string }
  /**
   * The ad account reports days in a different zone from the tenant's. Not an
   * error, and not silently correctable.
   */
  | { aligned: false; accountZone: string; tenantZone: string; detail: string };

/**
 * Whether the account's day boundaries match the tenant's.
 *
 * The convention is that dates are normalised into the tenant timezone at
 * ingest (§6), and for Salesforce that works because every record carries an
 * instant. Google Ads daily metrics do not: `segments.date` is a pre-aggregated
 * day in the *account's* reporting zone, and there is no finer grain available
 * to re-bucket from. A day cannot be shifted after the fact without inventing
 * an hourly split that was never reported.
 *
 * So where the zones differ this reports the mismatch rather than applying a
 * shift. The connector surfaces it as a connection dependency: an account whose
 * zone is wrong is a five-minute fix in Google Ads, and quietly relabelling
 * somebody else's midnight is not a fix at all.
 */
export function checkReportingZone(accountZone: string | null, tenantZone: string): ReportingZone {
  if (!accountZone) {
    return {
      aligned: false,
      accountZone: '(not reported)',
      tenantZone,
      detail:
        'The account did not report a timezone, so day boundaries cannot be ' +
        'confirmed to match the tenant’s.',
    };
  }
  if (accountZone === tenantZone) return { aligned: true, zone: accountZone };

  return {
    aligned: false,
    accountZone,
    tenantZone,
    detail:
      `The ad account reports days in ${accountZone}; this tenant's are in ` +
      `${tenantZone}. Daily spend arrives pre-aggregated by the account's ` +
      'calendar day and cannot be re-bucketed, so spend and CRM events near ' +
      'midnight fall on different days. Align the account timezone in Google ' +
      'Ads, or accept a boundary error of up to one day on every daily figure.',
  };
}
