import { CLICK_VIEW_LOOKBACK_DAYS } from './types';
import type { DateRange } from '@zeeraa/core';

/**
 * GAQL query construction.
 *
 * Pure string building, so every query in the connector is readable in a test
 * without a network call or a credential. GAQL has no parameter binding, so
 * every interpolated value is validated rather than escaped — the inputs here
 * are dates and numeric customer ids, and anything that is not exactly that
 * shape is a bug rather than a value to quote.
 */

export class GaqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GaqlError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function assertDay(day: string): string {
  if (!DAY.test(day)) throw new GaqlError(`"${day}" is not a YYYY-MM-DD date.`);
  // Rejects 2026-02-31 and friends, which match the pattern and are not days.
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new GaqlError(`"${day}" is not a real date.`);
  }
  return day;
}

/**
 * Customer ids go in the URL path, not in a query, so a bad one is a request to
 * the wrong account rather than a syntax error. Ten digits, no dashes — the
 * dashed form Google's UI displays is rejected by the API with an unhelpful
 * message, so it is normalised here instead.
 */
export function normalizeCustomerId(id: string): string {
  const digits = id.replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    throw new GaqlError(
      `"${id}" is not a Google Ads customer id. Expected ten digits, ` +
        'with or without dashes (e.g. 696-268-5494).',
    );
  }
  return digits;
}

/** Accounts reachable by the authenticated user. Used by `testConnection`. */
export function accountQuery(): string {
  return [
    'SELECT',
    '  customer.id,',
    '  customer.descriptive_name,',
    '  customer.currency_code,',
    '  customer.time_zone',
    'FROM customer',
    'LIMIT 1',
  ].join('\n');
}

/**
 * Campaigns, for the `campaigns` table.
 *
 * Removed campaigns are included deliberately: they still have spend in the
 * trailing window, and a daily_metrics row whose campaign cannot be resolved
 * would have to be written against a null campaign — turning a known campaign's
 * spend into unattributable account-level spend the moment somebody archives it.
 */
export function campaignQuery(): string {
  return [
    'SELECT',
    '  campaign.id,',
    '  campaign.name,',
    '  campaign.status,',
    '  campaign.advertising_channel_type',
    'FROM campaign',
  ].join('\n');
}

/**
 * Daily spend by campaign, batched by date range.
 *
 * This is the §6 rule working as intended: one request covers the whole
 * trailing window. `click_view` below is the exception, and the only one.
 */
export function dailyMetricsQuery(range: DateRange): string {
  const start = assertDay(range.start);
  const end = assertDay(range.end);
  if (start > end) throw new GaqlError(`Range starts after it ends: ${start} to ${end}.`);

  return [
    'SELECT',
    '  campaign.id,',
    '  segments.date,',
    '  metrics.impressions,',
    '  metrics.clicks,',
    '  metrics.cost_micros,',
    '  metrics.conversions',
    'FROM campaign',
    `WHERE segments.date BETWEEN '${start}' AND '${end}'`,
  ].join('\n');
}

/**
 * One day of clicks.
 *
 * `click_view` is the only resource exposing a `gclid`, and it carries two
 * limits nothing else does: the query must resolve to a single day, and the
 * data is served only for the 90 days before the request. A range here is not
 * a performance choice that could be tuned — it is rejected by the API.
 *
 * Both limits are documented in the amendment; the enforcement is here so that
 * a caller which forgets fails on its own machine rather than against quota.
 */
export function clickViewQuery(day: string): string {
  assertDay(day);
  return [
    'SELECT',
    '  click_view.gclid,',
    '  campaign.id,',
    '  ad_group.id,',
    '  segments.date,',
    '  segments.ad_network_type,',
    '  segments.device',
    'FROM click_view',
    `WHERE segments.date = '${day}'`,
  ].join('\n');
}

/**
 * The oldest day `click_view` will still serve, relative to `today`.
 *
 * Inclusive. A day before this is not a failed request to retry — it is a hole
 * in the record that no retry fills, and the ingest ledger records it as such.
 */
export function earliestClickDay(today: string, lookbackDays = CLICK_VIEW_LOOKBACK_DAYS): string {
  assertDay(today);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (lookbackDays - 1));
  return d.toISOString().slice(0, 10);
}

export function isWithinClickWindow(
  day: string,
  today: string,
  lookbackDays = CLICK_VIEW_LOOKBACK_DAYS,
): boolean {
  assertDay(day);
  return day >= earliestClickDay(today, lookbackDays) && day <= today;
}
