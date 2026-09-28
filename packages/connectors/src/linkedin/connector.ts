import type { Connection, ConnectionHealth, Connector } from '../types';
import { accountUrn, LinkedInApiError, LinkedInClient, restliDate } from './client';
import {
  analyticsChunks,
  checkLinkedInReportingZone,
  normalizeLinkedInCampaigns,
  normalizeLinkedInDailyMetrics,
} from './normalize';
import type {
  LinkedInAccountRow,
  LinkedInAnalyticsRow,
  LinkedInCampaignRow,
  LinkedInConfig,
} from './types';

/**
 * LinkedIn Ads, read-only, at campaign grain — the Meta pattern.
 *
 * `connection.credentials` here is `{ accessToken }`, already usable: the jobs
 * context refreshes it in memory from the stored grant before building the
 * connection, so nothing in this module ever sees a refresh token.
 *
 * There is no `fetchClicks`. LinkedIn has no API that resolves an `li_fat_id`
 * to a campaign, so a lead carrying one is credited to the channel and not to
 * a campaign — the same as a Meta click.
 */
const CAMPAIGN_STATUSES = 'List(ACTIVE,PAUSED,ARCHIVED,COMPLETED,CANCELED,DRAFT,PENDING_DELETION,REMOVED)';
const ANALYTICS_FIELDS =
  'dateRange,pivotValues,impressions,clicks,landingPageClicks,costInLocalCurrency,' +
  'externalWebsiteConversions,oneClickLeads';

function configOf(conn: Connection): LinkedInConfig {
  const config = conn.config as Partial<LinkedInConfig>;
  if (!config.adAccountId || !/^\d+$/.test(config.adAccountId)) {
    throw new Error('The LinkedIn connection has no numeric adAccountId in its config.');
  }
  return config as LinkedInConfig;
}

function tokenOf(conn: Connection): string {
  const token = (conn.credentials as { accessToken?: string }).accessToken;
  if (!token) throw new Error('The LinkedIn connection has no access token. Press Connect on Connections.');
  return token;
}

export function linkedInConnector(
  clientFactory: (conn: Connection) => LinkedInClient = (conn) =>
    new LinkedInClient(tokenOf(conn), configOf(conn).apiVersion),
): Connector {
  return {
    key: 'linkedin_ads',
    label: 'LinkedIn Ads',

    /**
     * Who the account is, then the three things that corrupt a daily figure:
     * the day boundary (always UTC on LinkedIn), the currency, and whether
     * the account is delivering.
     */
    async testConnection(conn: Connection): Promise<ConnectionHealth> {
      try {
        const config = configOf(conn);
        const account = await clientFactory(conn).get<LinkedInAccountRow>(`/adAccounts/${config.adAccountId}`);
        if (!account?.id) {
          return { state: 'failing', detail: 'The ad account query returned nothing.' };
        }
        if (account.status && !['ACTIVE', 'DRAFT'].includes(account.status)) {
          return {
            state: 'waiting_on_client',
            detail: `The LinkedIn ad account is ${account.status.toLowerCase().replaceAll('_', ' ')}.`,
          };
        }
        if (account.currency && account.currency !== conn.tenantCurrency) {
          return {
            state: 'degraded',
            detail:
              `The ad account bills in ${account.currency}; this tenant reports in ` +
              `${conn.tenantCurrency}. Spend would be added to another channel's ` +
              'without conversion, which is a wrong total rather than a missing one.',
          };
        }
        const zone = checkLinkedInReportingZone(conn.tenantTimezone);
        if (!zone.aligned) return { state: 'degraded', detail: zone.detail };
        return { state: 'healthy', accountName: account.name };
      } catch (error) {
        if (error instanceof LinkedInApiError) {
          if (error.waitingOnClient) {
            return {
              state: 'waiting_on_client',
              detail:
                `${error.detail} The LinkedIn grant stops working when it expires ` +
                '(a year after Connect), when it is revoked, or when the member who ' +
                'granted it loses access to the ad account. Press Connect again.',
            };
          }
          return { state: error.retryable ? 'degraded' : 'failing', detail: error.detail };
        }
        return { state: 'failing', detail: String(error) };
      }
    },

    async fetchEntities(conn: Connection) {
      const config = configOf(conn);
      const rows = await clientFactory(conn).all<LinkedInCampaignRow>(
        `/adAccounts/${config.adAccountId}/adCampaigns`,
        `q=search&search=(status:(values:${CAMPAIGN_STATUSES}))`,
      );
      return normalizeLinkedInCampaigns(rows, config.adAccountId);
    },

    async fetchDailyMetrics(conn: Connection, range: { start: string; end: string }) {
      const config = configOf(conn);
      const client = clientFactory(conn);
      const rows: LinkedInAnalyticsRow[] = [];
      for (const chunk of analyticsChunks(range)) {
        const query =
          'q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY' +
          `&dateRange=(start:${restliDate(chunk.start)},end:${restliDate(chunk.end)})` +
          `&accounts=List(${accountUrn(config.adAccountId)})` +
          `&fields=${ANALYTICS_FIELDS}`;
        const body = await client.get<{ elements?: LinkedInAnalyticsRow[] }>('/adAnalytics', query);
        rows.push(...(body.elements ?? []));
      }
      return normalizeLinkedInDailyMetrics(rows, config);
    },
  };
}
