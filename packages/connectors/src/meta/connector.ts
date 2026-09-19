import type { DateRange } from '@zeeraa/core';
import type {
  CampaignRow,
  Connection,
  ConnectionHealth,
  Connector,
  DailyMetricRow,
} from '../types';
import { MetaApiError, MetaClient } from './client';
import {
  accountStatusDetail,
  checkReportingZone,
  normalizeAccount,
  normalizeCampaigns,
  normalizeDailyMetrics,
} from './normalize';
import type { MetaAccountRow, MetaCampaignRow, MetaConfig, MetaCredentials, MetaInsightRow } from './types';

/**
 * The Meta Ads connector.
 *
 * Same interface as Google Ads, and deliberately **without `fetchClicks`**.
 *
 * That absence is the most important thing in this file. Google serves
 * `click_view`, which resolves a `gclid` to the campaign that produced it, and
 * that is what lets a funded deal be costed against a campaign. Meta publishes
 * no equivalent for `fbclid` — there is no endpoint, at any grain, that maps a
 * click identifier back to a campaign. So an `fbclid` on a lead proves the
 * channel and can never prove the campaign.
 *
 * The consequence is not a gap to be filled later, it is the shape of the
 * platform: **Meta attribution is channel-level, permanently.** It lands on the
 * case the model already has — Google's clicks that aged out of the 90-day
 * window still count for the channel and cannot be placed on a campaign — so
 * nothing downstream needs a new concept, and `ad_clicks` simply never holds a
 * Meta row. Implementing `fetchClicks` to return an empty array would have been
 * worse than omitting it: the click ledger would show 90 days of successful
 * ingestion that fetched nothing.
 */

function credentialsOf(conn: Connection): MetaCredentials {
  const c = conn.credentials as Partial<MetaCredentials>;
  if (!c.accessToken) {
    throw new Error(
      'The Meta connection is missing accessToken. Store a system user token ' +
        'with `pnpm --filter @zeeraa/db set-credentials <tenant> meta` — ' +
        'encrypted per tenant, never read from an environment variable at ' +
        'request time.',
    );
  }
  return c as MetaCredentials;
}

function configOf(conn: Connection): MetaConfig {
  const c = conn.config as Partial<MetaConfig>;
  if (!c.adAccountId) throw new Error('The Meta connection config has no adAccountId.');
  return c as MetaConfig;
}

const ACCOUNT_FIELDS = 'id,name,account_status,currency,timezone_name';
const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective';
const INSIGHT_FIELDS =
  'campaign_id,campaign_name,date_start,date_stop,spend,impressions,clicks,' +
  'inline_link_clicks,actions,account_currency';

export function metaConnector(
  clientFactory: (conn: Connection) => MetaClient = (conn) =>
    new MetaClient(credentialsOf(conn), configOf(conn)),
): Connector {
  return {
    key: 'meta',
    label: 'Meta Ads',

    /**
     * Asks the account who it is, then checks the three things that silently
     * corrupt a daily figure: the day boundary, the currency, and whether the
     * account is delivering at all.
     *
     * A currency mismatch is `degraded` rather than `failing` for the same
     * reason as a zone mismatch — the data arrives and is usable, but a spend
     * column that mixes two currencies is a wrong number rather than a missing
     * one, and somebody has to be told once.
     */
    async testConnection(conn: Connection): Promise<ConnectionHealth> {
      try {
        const client = clientFactory(conn);
        const account = normalizeAccount(
          await client.node<MetaAccountRow>(client.account, { fields: ACCOUNT_FIELDS }),
        );
        if (!account) {
          return {
            state: 'failing',
            detail:
              'The ad account query returned nothing. The account id is probably ' +
              'not one this system user can reach.',
          };
        }

        const zone = checkReportingZone(account.timeZone, conn.tenantTimezone);
        if (!zone.aligned) return { state: 'degraded', detail: zone.detail };

        if (account.currency && account.currency !== conn.tenantCurrency) {
          return {
            state: 'degraded',
            detail:
              `The ad account bills in ${account.currency}; this tenant reports in ` +
              `${conn.tenantCurrency}. Spend would be added to another channel's ` +
              'without conversion, which is a wrong total rather than a missing one.',
          };
        }

        const status = accountStatusDetail(account.accountStatus);
        if (status) return { state: 'waiting_on_client', detail: status };

        return { state: 'healthy', accountName: account.name };
      } catch (error) {
        if (error instanceof MetaApiError) {
          if (error.waitingOnClient) {
            return {
              state: 'waiting_on_client',
              detail:
                `${error.detail} A system user token stops working when it is ` +
                'revoked, when the system user loses access to the ad account, or ' +
                'when the app’s permissions change — all of which are changes in ' +
                'the client’s Business Manager rather than here.',
            };
          }
          return { state: error.retryable ? 'degraded' : 'failing', detail: error.detail };
        }
        return { state: 'failing', detail: String(error) };
      }
    },

    async fetchEntities(conn: Connection): Promise<CampaignRow[]> {
      const client = clientFactory(conn);
      return normalizeCampaigns(
        await client.edge<MetaCampaignRow>(`${client.account}/campaigns`, {
          fields: CAMPAIGN_FIELDS,
          limit: '200',
        }),
      );
    },

    /**
     * One request for the whole window, as §6 requires.
     *
     * `time_increment=1` is what makes the response one row per campaign per
     * day rather than one aggregate for the range. Without it Meta returns a
     * single summed row per campaign and every day of it would be written under
     * the window's start date.
     */
    async fetchDailyMetrics(conn: Connection, range: DateRange): Promise<DailyMetricRow[]> {
      const client = clientFactory(conn);
      const config = configOf(conn);

      try {
        const rows = await client.edge<MetaInsightRow>(`${client.account}/insights`, {
          level: 'campaign',
          time_increment: '1',
          time_range: JSON.stringify({ since: range.start, until: range.end }),
          fields: INSIGHT_FIELDS,
          limit: '500',
        });

        return normalizeDailyMetrics(rows, {
          conversionActionTypes: config.conversionActionTypes,
          clickMetric: config.clickMetric,
        });
      } catch (error) {
        if (error instanceof MetaApiError && error.needsAsyncJob) {
          throw new Error(
            'Meta refused this insights request as too large and wants it ' +
              'submitted as an async job. This connector reads campaign grain ' +
              'synchronously, which returns about one row per campaign per day. ' +
              'Narrow the window rather than widening the grain — and if a ' +
              'client genuinely needs ad-level history, the async submit-and-poll ' +
              'path is the change to make, not a larger synchronous request.',
            { cause: error },
          );
        }
        throw error;
      }
    },

    // No fetchClicks. See the note at the top of this file: Meta publishes no
    // endpoint that resolves an fbclid to a campaign, so there is nothing to
    // fetch and an empty implementation would fake a ledger of ingested days.
  };
}
