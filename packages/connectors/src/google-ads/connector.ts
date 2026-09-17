import type { DateRange } from '@zeeraa/core';
import type {
  CampaignRow,
  ClickRow,
  Connection,
  ConnectionHealth,
  Connector,
  DailyMetricRow,
} from '../types';
import { GoogleAdsAccessError, GoogleAdsApiError, GoogleAdsClient } from './client';
import { GoogleAdsAuthError } from './auth';
import {
  accountQuery,
  assertDay,
  campaignQuery,
  clickViewQuery,
  dailyMetricsQuery,
  earliestClickDay,
  isWithinClickWindow,
} from './gaql';
import {
  checkReportingZone,
  normalizeAccount,
  normalizeCampaigns,
  normalizeClicks,
  normalizeDailyMetrics,
} from './normalize';
import type { GoogleAdsConfig, GoogleAdsCredentials } from './types';

/**
 * The Google Ads connector.
 *
 * Every credential is per tenant. Spartan reaches their account through their
 * own manager account rather than a Zeeraa MCC, so the OAuth consent, the Cloud
 * project that carries the API access level, and the manager id all belong to
 * the client. Another tenant may hand over a different arrangement entirely and
 * needs no code change for it.
 */

export class ClickWindowExpiredError extends Error {
  constructor(
    readonly day: string,
    readonly earliest: string,
  ) {
    super(
      `${day} is outside the click_view window, which currently reaches back to ` +
        `${earliest}. This is not a retryable failure — Google no longer serves ` +
        'click data for that day, and no request will recover it.',
    );
    this.name = 'ClickWindowExpiredError';
  }
}

function credentialsOf(conn: Connection): GoogleAdsCredentials {
  const c = conn.credentials as Partial<GoogleAdsCredentials>;
  if (!c.clientId || !c.clientSecret || !c.refreshToken) {
    throw new Error(
      'The Google Ads connection is missing clientId, clientSecret or refreshToken. ' +
        'Generate a refresh token with `pnpm --filter @zeeraa/connectors ' +
        'google-ads-token`. A developer token is not required — Google sunset them ' +
        'on 9 September 2026.',
    );
  }
  return c as GoogleAdsCredentials;
}

function configOf(conn: Connection): GoogleAdsConfig {
  const c = conn.config as Partial<GoogleAdsConfig>;
  if (!c.customerId) {
    throw new Error('The Google Ads connection config has no customerId.');
  }
  return c as GoogleAdsConfig;
}

export function googleAdsConnector(
  clientFactory: (conn: Connection) => GoogleAdsClient = (conn) =>
    new GoogleAdsClient(credentialsOf(conn), configOf(conn)),
): Connector {
  return {
    key: 'google_ads',
    label: 'Google Ads',

    /**
     * Asks the account who it is, and checks its day boundaries against the
     * tenant's.
     *
     * A healthy-but-misaligned account reports `degraded` rather than `healthy`.
     * The data arrives and is usable; every daily figure carries a boundary
     * error of up to a day, and that is a fact somebody should be told once
     * rather than discover from a reconciliation.
     */
    async testConnection(conn: Connection): Promise<ConnectionHealth> {
      try {
        const rows = await clientFactory(conn).search(accountQuery());
        const account = rows[0] ? normalizeAccount(rows[0]) : null;
        if (!account) {
          return {
            state: 'failing',
            detail:
              'The account query returned no rows. The customer id is probably ' +
              'not reachable by this OAuth user.',
          };
        }

        const zone = checkReportingZone(account.timeZone, conn.tenantTimezone);
        if (!zone.aligned) {
          return { state: 'degraded', detail: zone.detail };
        }
        return { state: 'healthy', accountName: account.name };
      } catch (error) {
        if (error instanceof GoogleAdsAuthError) {
          return {
            state: error.failure.waitingOnClient ? 'waiting_on_client' : 'failing',
            detail: `${error.failure.description} ${error.failure.remedy}`,
          };
        }
        if (error instanceof GoogleAdsAccessError) {
          return { state: 'waiting_on_client', detail: `${error.message} ${error.remedy}` };
        }
        if (error instanceof GoogleAdsApiError) {
          return { state: error.retryable ? 'degraded' : 'failing', detail: error.message };
        }
        return { state: 'failing', detail: String(error) };
      }
    },

    async fetchEntities(conn: Connection): Promise<CampaignRow[]> {
      return normalizeCampaigns(await clientFactory(conn).search(campaignQuery()));
    },

    /** Batched by date range, as §6 requires. One request, whole window. */
    async fetchDailyMetrics(conn: Connection, range: DateRange): Promise<DailyMetricRow[]> {
      return normalizeDailyMetrics(await clientFactory(conn).search(dailyMetricsQuery(range)));
    },

    /**
     * One day of clicks.
     *
     * Refuses a day outside the lookback window before spending a request on
     * it. The caller needs to distinguish "ask again later" from "this is gone
     * for good", and an API error for an aged-out day does not say which.
     */
    async fetchClicks(conn: Connection, day: string): Promise<ClickRow[]> {
      assertDay(day);
      const today = todayInZone(conn.tenantTimezone);
      if (!isWithinClickWindow(day, today)) {
        throw new ClickWindowExpiredError(day, earliestClickDay(today));
      }
      return normalizeClicks(await clientFactory(conn).search(clickViewQuery(day)));
    },
  };
}

function todayInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
