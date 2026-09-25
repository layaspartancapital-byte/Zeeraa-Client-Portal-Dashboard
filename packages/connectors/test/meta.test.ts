import { describe, expect, it, vi } from 'vitest';
import { MetaApiError, MetaClient } from '../src/meta/client';
import {
  accountStatusDetail,
  checkReportingZone,
  conversionsFrom,
  normalizeAccount,
  normalizeCampaigns,
  normalizeDailyMetrics,
} from '../src/meta/normalize';
import { metaConnector } from '../src/meta/connector';
import type { Connection } from '../src/types';
import type { MetaConfig, MetaCredentials, MetaInsightRow } from '../src/meta/types';

const CREDENTIALS: MetaCredentials = { accessToken: 'EAA-system-user-token' };
const CONFIG: MetaConfig = { adAccountId: '648661540906332' };

const CONNECTION: Connection = {
  id: 'conn-meta',
  tenantId: 'tenant-1',
  platform: 'meta',
  accountIdentifier: '648661540906332',
  credentials: CREDENTIALS as unknown as Record<string, unknown>,
  config: CONFIG as unknown as Record<string, unknown>,
  tenantTimezone: 'America/New_York',
  tenantCurrency: 'USD',
};

/** Shaped from a real response on 19 September 2026, trimmed. */
const INSIGHT_ROW: MetaInsightRow = {
  campaign_id: '120243452733060176',
  campaign_name: 'Spartan Capital — Lead Gen 04/22/2026',
  date_start: '2026-06-21',
  date_stop: '2026-06-21',
  spend: '147.33',
  impressions: '1363',
  clicks: '72',
  inline_link_clicks: '61',
  account_currency: 'USD',
  actions: [
    { action_type: 'link_click', value: '61' },
    { action_type: 'landing_page_view', value: '51' },
    // The overlap that makes "sum every action" wrong: `lead` is the rollup of
    // the two below it, and nothing in the payload says so.
    { action_type: 'lead', value: '9' },
    { action_type: 'onsite_web_lead', value: '5' },
    { action_type: 'onsite_conversion.lead_grouped', value: '4' },
    { action_type: 'page_engagement', value: '120' },
    { action_type: 'post_engagement', value: '119' },
  ],
};

function jsonFetch(payloads: unknown[]): typeof fetch {
  const queue = [...payloads];
  return vi.fn(async () => {
    const body = queue.shift() ?? { data: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('the ad account id', () => {
  it('is act_-prefixed however it was configured', () => {
    const bare = new MetaClient(CREDENTIALS, { adAccountId: '648661540906332' });
    const prefixed = new MetaClient(CREDENTIALS, { adAccountId: 'act_648661540906332' });
    expect(bare.account).toBe('act_648661540906332');
    expect(prefixed.account).toBe('act_648661540906332');
  });
});

describe('errors', () => {
  it('reads Meta’s own code rather than the HTTP status', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Error validating access token: the session has been invalidated.',
            type: 'OAuthException',
            code: 190,
            error_subcode: 460,
            fbtrace_id: 'Axyz',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const client = new MetaClient(CREDENTIALS, CONFIG, fetchImpl);
    const thrown: unknown = await client.node('act_1', { fields: 'id' }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(MetaApiError);
    const error = thrown as MetaApiError;
    expect(error.code).toBe(190);
    expect(error.subcode).toBe(460);
    expect(error.traceId).toBe('Axyz');
    // Every Meta error is a 400; classifying on status would make this
    // indistinguishable from a malformed query and retry it forever.
    expect(error.status).toBe(400);
    expect(error.waitingOnClient).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it.each([
    [4, 'app-level throttle'],
    [17, 'user-level throttle'],
    [80000, 'insights throttle'],
  ])('treats code %i as retryable (%s)', (code) => {
    const error = new MetaApiError(400, '/x', code, null, null, null, 'slow down');
    expect(error.retryable).toBe(true);
    expect(error.waitingOnClient).toBe(false);
  });

  it('recognises the request Meta wants submitted as an async job', () => {
    const error = new MetaApiError(
      400, '/insights', 1, null, null, null,
      'Please reduce the amount of data you’re asking for, then retry your request',
    );
    expect(error.needsAsyncJob).toBe(true);
  });
});

describe('paging', () => {
  it('follows the cursor and concatenates every page', async () => {
    const fetchImpl = jsonFetch([
      { data: [{ id: '1' }, { id: '2' }], paging: { next: 'https://graph.facebook.com/next-1' } },
      { data: [{ id: '3' }] },
    ]);
    const client = new MetaClient(CREDENTIALS, CONFIG, fetchImpl);
    const rows = await client.edge<{ id: string }>('act_1/campaigns', { fields: 'id' });
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('stops rather than looping forever on a cursor that never ends', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'x' }], paging: { next: 'https://x/next' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const client = new MetaClient(CREDENTIALS, CONFIG, fetchImpl);
    await expect(client.edge('act_1/campaigns', {}, 3)).rejects.toThrow(/never ended/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('conversions', () => {
  it('counts only the configured action types', () => {
    expect(conversionsFrom(INSIGHT_ROW.actions, ['lead'])).toBe(9);
  });

  it('does not sum a rollup with its own components', () => {
    // 9 + 5 + 4 = 18, against 9 real leads. This is the misconfiguration the
    // default exists to avoid, and it is arithmetic rather than an error.
    expect(conversionsFrom(INSIGHT_ROW.actions, ['lead', 'onsite_web_lead'])).toBe(14);
    expect(conversionsFrom(INSIGHT_ROW.actions, ['lead'])).toBe(9);
  });

  it('is zero where the account reports no actions at all', () => {
    expect(conversionsFrom(undefined, ['lead'])).toBe(0);
    expect(conversionsFrom([], ['lead'])).toBe(0);
  });
});

describe('daily metrics', () => {
  it('uses inline_link_clicks, not clicks', () => {
    const [row] = normalizeDailyMetrics([INSIGHT_ROW]);
    // 61 link clicks against 72 total: the difference is reactions, comments
    // and profile taps, which Google Ads' `clicks` never counted.
    expect(row!.clicks).toBe(61);
  });

  it('can be configured onto total clicks, and says which it used', () => {
    const [row] = normalizeDailyMetrics([INSIGHT_ROW], { clickMetric: 'clicks' });
    expect(row!.clicks).toBe(72);
  });

  it('reads spend as major units', () => {
    const [row] = normalizeDailyMetrics([INSIGHT_ROW]);
    // Not 14733. `insights.spend` is a decimal string; only `amount_spent` on
    // the account node is in minor units.
    expect(row!.spend).toBeCloseTo(147.33, 2);
  });

  it('drops a row with no date rather than defaulting it', () => {
    // The date is part of the upsert key; guessing it would overwrite another
    // day's spend.
    expect(normalizeDailyMetrics([{ ...INSIGHT_ROW, date_start: undefined }])).toHaveLength(0);
  });

  it('carries the campaign id through as a string', () => {
    const [row] = normalizeDailyMetrics([INSIGHT_ROW]);
    expect(row!.externalCampaignId).toBe('120243452733060176');
    expect(row!.date).toBe('2026-06-21');
    expect(row!.impressions).toBe(1363);
    expect(row!.platformConversions).toBe(9);
  });
});

describe('campaigns', () => {
  it('reports effective_status, which is what actually delivered', () => {
    const [row] = normalizeCampaigns([
      { id: '1', name: 'A', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' },
    ]);
    expect(row!.status).toBe('CAMPAIGN_PAUSED');
  });

  it('skips a row with no id', () => {
    expect(normalizeCampaigns([{ name: 'nameless' }])).toHaveLength(0);
  });
});

describe('the account', () => {
  it('strips the act_ prefix from the external id', () => {
    const account = normalizeAccount({
      id: 'act_648661540906332',
      name: 'Spartan Capital (2025)',
      currency: 'USD',
      timezone_name: 'America/New_York',
      account_status: 1,
    });
    expect(account!.externalAccountId).toBe('648661540906332');
    expect(account!.accountStatus).toBe(1);
  });

  it.each([
    [2, /disabled/i],
    [3, /unsettled/i],
    [101, /closed/i],
  ])('explains status %i in words', (status, pattern) => {
    expect(accountStatusDetail(status)).toMatch(pattern);
  });

  it('says nothing about an active account', () => {
    expect(accountStatusDetail(1)).toBeNull();
  });
});

describe('the reporting zone', () => {
  it('is aligned when the account and the tenant agree', () => {
    expect(checkReportingZone('America/New_York', 'America/New_York')).toEqual({
      aligned: true,
      zone: 'America/New_York',
    });
  });

  it('explains the boundary error rather than just flagging it', () => {
    const zone = checkReportingZone('America/Los_Angeles', 'America/New_York');
    expect(zone.aligned).toBe(false);
    expect(zone.aligned === false && zone.detail).toMatch(/cannot be re-bucketed/i);
  });
});

describe('the connector', () => {
  it('reports healthy on an aligned, active account', async () => {
    const connector = metaConnector(
      () =>
        new MetaClient(
          CREDENTIALS,
          CONFIG,
          jsonFetch([
            {
              id: 'act_648661540906332',
              name: 'Spartan Capital (2025)',
              currency: 'USD',
              timezone_name: 'America/New_York',
              account_status: 1,
            },
          ]),
        ),
    );
    await expect(connector.testConnection(CONNECTION)).resolves.toEqual({
      state: 'healthy',
      accountName: 'Spartan Capital (2025)',
    });
  });

  it('degrades on a currency the tenant does not report in', async () => {
    const connector = metaConnector(
      () =>
        new MetaClient(
          CREDENTIALS,
          CONFIG,
          jsonFetch([
            { id: 'act_1', name: 'A', currency: 'CAD', timezone_name: 'America/New_York', account_status: 1 },
          ]),
        ),
    );
    const health = await connector.testConnection(CONNECTION);
    expect(health.state).toBe('degraded');
    expect(health.state === 'degraded' && health.detail).toMatch(/CAD/);
  });

  it('waits on the client when the ad account is disabled', async () => {
    const connector = metaConnector(
      () =>
        new MetaClient(
          CREDENTIALS,
          CONFIG,
          jsonFetch([
            { id: 'act_1', name: 'A', currency: 'USD', timezone_name: 'America/New_York', account_status: 2 },
          ]),
        ),
    );
    const health = await connector.testConnection(CONNECTION);
    expect(health.state).toBe('waiting_on_client');
  });

  it('asks for one row per campaign per day', async () => {
    const fetchImpl = jsonFetch([{ data: [INSIGHT_ROW] }]);
    const connector = metaConnector(() => new MetaClient(CREDENTIALS, CONFIG, fetchImpl));
    const rows = await connector.fetchDailyMetrics(CONNECTION, {
      start: '2026-06-21',
      end: '2026-09-18',
    });

    expect(rows).toHaveLength(1);
    const url = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    // Without time_increment=1 Meta returns one summed row per campaign and the
    // whole window would be written under its first day.
    expect(url).toContain('time_increment=1');
    expect(url).toContain('level=campaign');
    expect(decodeURIComponent(url)).toContain('{"since":"2026-06-21","until":"2026-09-18"}');
  });

  it('has no fetchClicks, because Meta publishes no fbclid-to-campaign lookup', () => {
    // Not an oversight and not a stub. An implementation returning [] would
    // write a click ledger showing 90 days successfully ingesting nothing.
    expect(metaConnector().fetchClicks).toBeUndefined();
  });

  it('refuses a connection with no access token, naming how to store one', () => {
    const connector = metaConnector();
    return expect(
      connector.fetchEntities!({ ...CONNECTION, credentials: {} }),
    ).rejects.toThrow(/set-credentials/);
  });
});

describe('fetchAdNames', () => {
  it('asks the account’s own ads edge, filtered by id, in every status', async () => {
    const fetchImpl = jsonFetch([{ data: [{ id: '120248746573600176', name: 'SCG Submit' }] }]);
    const connector = metaConnector(() => new MetaClient(CREDENTIALS, CONFIG, fetchImpl));
    const names = await connector.fetchAdNames!(CONNECTION, [
      '120248746573600176',
      '120248746573610176',
      '120248746573600176',
      'not-an-id',
    ]);
    expect(names).toEqual([{ id: '120248746573600176', name: 'SCG Submit' }]);

    const url = new URL(String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]));
    expect(url.pathname).toMatch(/\/act_648661540906332\/ads$/);
    const filtering = JSON.parse(url.searchParams.get('filtering')!);
    expect(filtering[0]).toEqual({
      field: 'id',
      operator: 'IN',
      value: ['120248746573600176', '120248746573610176'],
    });
    expect(filtering[1].value).toContain('ARCHIVED');
  });

  it('batches fifty ids to a request', async () => {
    const fetchImpl = jsonFetch([{ data: [] }, { data: [] }]);
    const connector = metaConnector(() => new MetaClient(CREDENTIALS, CONFIG, fetchImpl));
    await connector.fetchAdNames!(CONNECTION, Array.from({ length: 51 }, (_, i) => String(1000 + i)));
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });
});
