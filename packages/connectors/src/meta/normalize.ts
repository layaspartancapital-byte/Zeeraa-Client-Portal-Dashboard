import type { CampaignRow, DailyMetricRow } from '../types';
import type {
  MetaAccount,
  MetaAccountRow,
  MetaAction,
  MetaCampaignRow,
  MetaInsightRow,
} from './types';

export const DEFAULT_CONVERSION_ACTION_TYPES = ['lead'] as const;

export function normalizeAccount(row: MetaAccountRow | null): MetaAccount | null {
  if (!row?.id) return null;
  return {
    externalAccountId: String(row.id).replace(/^act_/, ''),
    name: row.name ?? `Account ${row.id}`,
    currency: row.currency ?? null,
    timeZone: row.timezone_name ?? null,
    accountStatus: typeof row.account_status === 'number' ? row.account_status : null,
  };
}

export function normalizeCampaigns(rows: readonly MetaCampaignRow[]): CampaignRow[] {
  const out: CampaignRow[] = [];
  for (const row of rows) {
    if (!row.id) continue;
    out.push({
      externalCampaignId: String(row.id),
      name: row.name ?? `Campaign ${row.id}`,
      // `effective_status` is the one that reflects delivery — a campaign can be
      // ACTIVE inside a paused ad set and spend nothing. `status` is what the
      // advertiser set; this is what actually happened.
      status: row.effective_status ?? row.status,
    });
  }
  return out;
}

/**
 * Daily metrics, one row per campaign per day.
 *
 * A row with no `date_start` is dropped rather than defaulted: the date is part
 * of the upsert key, and guessing it would overwrite one day's spend with
 * another's. Same rule as the Google Ads normaliser, for the same reason.
 */
export function normalizeDailyMetrics(
  rows: readonly MetaInsightRow[],
  options: {
    conversionActionTypes?: readonly string[];
    clickMetric?: 'inline_link_clicks' | 'clicks';
  } = {},
): DailyMetricRow[] {
  const conversionTypes = options.conversionActionTypes ?? DEFAULT_CONVERSION_ACTION_TYPES;
  const clickMetric = options.clickMetric ?? 'inline_link_clicks';

  const out: DailyMetricRow[] = [];
  for (const row of rows) {
    const date = row.date_start;
    if (!date) continue;
    out.push({
      date,
      externalCampaignId: row.campaign_id ? String(row.campaign_id) : null,
      impressions: count(row.impressions),
      clicks: count(row[clickMetric]),
      // A decimal string in the account's currency, already in major units —
      // unlike `amount_spent` on the account node, which is in minor units. The
      // two are different scales in the same API and mixing them up is a
      // hundredfold error in a spend figure.
      spend: money(row.spend),
      platformConversions: conversionsFrom(row.actions, conversionTypes),
    });
  }
  return out;
}

/**
 * Conversions, from the configured action types only.
 *
 * Never "sum every action". Meta's `actions` array contains rollups alongside
 * their own components — `lead` is `onsite_web_lead` plus
 * `onsite_conversion.lead_grouped`, and `page_engagement` subsumes
 * `post_engagement` — and nothing in the response marks which nest. Adding them
 * up produces a number that is roughly double the truth and looks plausible.
 */
export function conversionsFrom(
  actions: readonly MetaAction[] | undefined,
  types: readonly string[],
): number {
  if (!actions || actions.length === 0) return 0;
  const wanted = new Set(types);
  let total = 0;
  for (const action of actions) {
    if (wanted.has(action.action_type)) total += money(action.value);
  }
  return total;
}

function count(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export type ReportingZone =
  | { aligned: true; zone: string }
  | { aligned: false; accountZone: string; tenantZone: string; detail: string };

/**
 * Whether the ad account's calendar day is the tenant's.
 *
 * Identical in shape to the Google Ads check, and identical in consequence:
 * daily spend arrives pre-aggregated on the account's boundary with no finer
 * grain to re-bucket from, so a mismatch is a boundary error on every daily
 * figure rather than something a conversion can fix.
 */
export function checkReportingZone(accountZone: string | null, tenantZone: string): ReportingZone {
  if (!accountZone) {
    return {
      aligned: false,
      accountZone: '(not reported)',
      tenantZone,
      detail:
        'The ad account did not report a timezone, so day boundaries cannot be ' +
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
      'midnight fall on different days. Align the account timezone in Meta ' +
      'Ads Manager, or accept a boundary error of up to one day on every ' +
      'daily figure.',
  };
}

/** Meta's ad-account status codes, in the words a reader needs. */
export function accountStatusDetail(status: number | null): string | null {
  switch (status) {
    case null:
    case 1:
      return null;
    case 2:
      return 'The ad account is disabled, so nothing is delivering.';
    case 3:
      return 'The ad account is unsettled: a payment has failed and delivery is stopped.';
    case 7:
      return 'The ad account is pending review and is not delivering.';
    case 9:
      return 'The ad account is in a grace period after a failed payment.';
    case 101:
      return 'The ad account is closed.';
    default:
      return `The ad account reports status ${status}, which is not the active state.`;
  }
}
