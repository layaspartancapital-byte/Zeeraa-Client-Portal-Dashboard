import { describe, expect, it } from 'vitest';
import {
  accessTokenUsable,
  analyticsChunks,
  exchangeLinkedInCode,
  linkedInAuthorizeUrl,
  linkedInConnector,
  normalizeLinkedInDailyMetrics,
  refreshLinkedInToken,
  restliDate,
  urnId,
  type Connection,
} from '../src/index';

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: 'c', tenantId: 't', platform: 'linkedin_ads', accountIdentifier: '509908440',
  credentials: { accessToken: 'token' }, config: { adAccountId: '509908440' },
  tenantTimezone: 'America/New_York', tenantCurrency: 'USD', ...over,
});

function recorder(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const r = responses[key]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('normalizeLinkedInDailyMetrics', () => {
  it('reads a UTC day per campaign, spend from the decimal string, and sums the configured conversions', () => {
    const rows = normalizeLinkedInDailyMetrics(
      [
        {
          dateRange: { start: { year: 2026, month: 9, day: 7 }, end: { year: 2026, month: 9, day: 7 } },
          pivotValues: ['urn:li:sponsoredCampaign:123456'],
          impressions: 1500, clicks: 40, landingPageClicks: 31, costInLocalCurrency: '212.47',
          externalWebsiteConversions: 2, oneClickLeads: 3,
        },
        { pivotValues: ['urn:li:sponsoredCampaign:9'], impressions: 1 },
      ],
      {},
    );
    expect(rows).toEqual([
      { date: '2026-09-07', externalCampaignId: '123456', impressions: 1500, clicks: 31, spend: 212.47, platformConversions: 5, allClicks: 40 },
    ]);
  });

  it('honours the configured click metric and conversion list', () => {
    const [row] = normalizeLinkedInDailyMetrics(
      [{ dateRange: { start: { year: 2026, month: 9, day: 1 } }, clicks: 10, landingPageClicks: 4, externalWebsiteConversions: 1, oneClickLeads: 9 }],
      { clickMetric: 'clicks', conversionMetrics: ['oneClickLeads'] },
    );
    expect(row).toMatchObject({ clicks: 10, platformConversions: 9 });
  });
});

describe('Rest.li request shape', () => {
  it('writes dates and ids as LinkedIn reads them', () => {
    expect(restliDate('2026-09-01')).toBe('(year:2026,month:9,day:1)');
    expect(urnId('urn:li:sponsoredCampaign:42')).toBe('42');
    expect(urnId(undefined)).toBeNull();
  });

  it('chunks a range into thirty-day pieces with no gap and no overlap', () => {
    expect(analyticsChunks({ start: '2026-07-01', end: '2026-09-28' })).toEqual([
      { start: '2026-07-01', end: '2026-07-30' },
      { start: '2026-07-31', end: '2026-08-29' },
      { start: '2026-08-30', end: '2026-09-28' },
    ]);
  });

  it('asks adAnalytics by campaign, daily, for the account, with the version headers', async () => {
    const { calls, fetchImpl } = recorder({ '/adAnalytics': { body: { elements: [] } } });
    const { LinkedInClient } = await import('../src/linkedin/client');
    const connector = linkedInConnector(() => new LinkedInClient('token', '202609', fetchImpl));
    await connector.fetchDailyMetrics(conn(), { start: '2026-09-01', end: '2026-09-28' });
    const url = calls[0]!.url;
    expect(url).toContain('q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY');
    expect(url).toContain('dateRange=(start:(year:2026,month:9,day:1),end:(year:2026,month:9,day:28))');
    expect(url).toContain('accounts=List(urn%3Ali%3AsponsoredAccount%3A509908440)');
    expect(url).toContain('costInLocalCurrency');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['linkedin-version']).toBe('202609');
    expect(headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(headers.authorization).toBe('Bearer token');
  });
});

describe('testConnection', () => {
  const connect = (responses: Record<string, { status?: number; body: unknown }>) => {
    const { fetchImpl } = recorder(responses);
    return import('../src/linkedin/client').then(({ LinkedInClient }) =>
      linkedInConnector(() => new LinkedInClient('token', '202609', fetchImpl)).testConnection(conn()),
    );
  };

  it('is degraded, saying why, for a working account: LinkedIn days are UTC', async () => {
    const health = await connect({ '/adAccounts/509908440': { body: { id: 509908440, name: 'Spartan', currency: 'USD', status: 'ACTIVE' } } });
    expect(health.state).toBe('degraded');
    expect('detail' in health && health.detail).toMatch(/UTC/);
  });

  it('is waiting on the client when the grant is refused', async () => {
    const health = await connect({ '/adAccounts/509908440': { status: 403, body: { message: 'Not enough permissions', code: 'ACCESS_DENIED' } } });
    expect(health.state).toBe('waiting_on_client');
  });

  it('flags a currency the tenant does not report in', async () => {
    const health = await connect({ '/adAccounts/509908440': { body: { id: 1, currency: 'EUR', status: 'ACTIVE' } } });
    expect(health.state).toBe('degraded');
    expect('detail' in health && health.detail).toMatch(/EUR/);
  });

  it('treats a canceled account as waiting on the client', async () => {
    const health = await connect({ '/adAccounts/509908440': { body: { id: 1, currency: 'USD', status: 'CANCELED' } } });
    expect(health.state).toBe('waiting_on_client');
  });
});

describe('the OAuth grant', () => {
  const app = { clientId: 'id', clientSecret: 'secret' };
  const now = new Date('2026-09-28T12:00:00Z');

  it('asks for exactly r_ads and r_ads_reporting, back to the given redirect', () => {
    const url = new URL(linkedInAuthorizeUrl(app, 'https://zeeraa.cloud/api/oauth/linkedin/callback', 'st'));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('r_ads r_ads_reporting');
    expect(url.searchParams.get('redirect_uri')).toBe('https://zeeraa.cloud/api/oauth/linkedin/callback');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('turns lifetimes into instants', async () => {
    const { fetchImpl, calls } = recorder({
      accessToken: { body: { access_token: 'a', expires_in: 5184000, refresh_token: 'r', refresh_token_expires_in: 31536000, scope: 'r_ads,r_ads_reporting' } },
    });
    const grant = await exchangeLinkedInCode(app, 'code', 'https://zeeraa.cloud/api/oauth/linkedin/callback', { now, fetchImpl });
    expect(grant).toEqual({
      accessToken: 'a', accessTokenExpiresAt: '2026-11-27T12:00:00.000Z',
      refreshToken: 'r', refreshTokenExpiresAt: '2027-09-28T12:00:00.000Z', scope: 'r_ads,r_ads_reporting',
    });
    expect(String(calls[0]!.init!.body)).toContain('grant_type=authorization_code');
  });

  it('keeps the refresh token and its expiry when a refresh does not restate them', async () => {
    const { fetchImpl } = recorder({ accessToken: { body: { access_token: 'b', expires_in: 5184000 } } });
    const grant = await refreshLinkedInToken(
      app,
      { accessToken: 'a', accessTokenExpiresAt: '2026-09-01T00:00:00Z', refreshToken: 'r', refreshTokenExpiresAt: '2027-09-28T12:00:00.000Z', scope: 's' },
      { now, fetchImpl },
    );
    expect(grant).toMatchObject({ accessToken: 'b', refreshToken: 'r', refreshTokenExpiresAt: '2027-09-28T12:00:00.000Z' });
  });

  it('reports a refused code as an error, not a grant', async () => {
    const { fetchImpl } = recorder({ accessToken: { status: 400, body: { error: 'invalid_request', error_description: 'expired code' } } });
    await expect(exchangeLinkedInCode(app, 'c', 'r', { fetchImpl })).rejects.toThrow(/expired code/);
  });

  it('uses a stored access token only while it has more than five minutes left', () => {
    expect(accessTokenUsable({ accessTokenExpiresAt: '2026-09-28T12:10:00Z' }, now)).toBe(true);
    expect(accessTokenUsable({ accessTokenExpiresAt: '2026-09-28T12:04:00Z' }, now)).toBe(false);
  });
});
