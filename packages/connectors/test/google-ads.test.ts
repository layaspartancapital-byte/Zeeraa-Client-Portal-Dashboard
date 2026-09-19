import { describe, expect, it, vi } from 'vitest';
import {
  accountQuery,
  assertDay,
  campaignQuery,
  clickViewQuery,
  dailyMetricsQuery,
  earliestClickDay,
  GaqlError,
  isWithinClickWindow,
  normalizeCustomerId,
} from '../src/google-ads/gaql';
import {
  checkReportingZone,
  fromMicros,
  normalizeAccount,
  normalizeCampaigns,
  normalizeClicks,
  normalizeDailyMetrics,
} from '../src/google-ads/normalize';
import {
  GoogleAdsAuthError,
  requestGoogleAdsAccessToken,
  requestHeaders,
} from '../src/google-ads/auth';
import { GoogleAdsAccessError, GoogleAdsApiError, GoogleAdsClient } from '../src/google-ads/client';
import { ClickWindowExpiredError, googleAdsConnector } from '../src/google-ads/connector';
import type { Connection } from '../src/types';
import { cloudProjectNumber } from '../src/google-ads/types';
import type { GoogleAdsCredentials, GoogleAdsRow } from '../src/google-ads/types';

const CREDENTIALS: GoogleAdsCredentials = {
  clientId: '123456789012-abcdefg.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret',
  refreshToken: '1//0refresh',
};

const CONNECTION: Connection = {
  id: 'conn-1',
  tenantId: 'tenant-1',
  platform: 'google_ads',
  accountIdentifier: '123-456-7890',
  credentials: CREDENTIALS as unknown as Record<string, unknown>,
  // Spartan's own manager account, not a Zeeraa MCC.
  config: { customerId: '1234567890', loginCustomerId: '6962685494' },
  tenantTimezone: 'America/New_York',
  tenantCurrency: 'USD',
};

describe('customer ids', () => {
  it('accepts the dashed form Google’s UI displays', () => {
    // The API rejects dashes with an unhelpful message, so they are stripped
    // here rather than left for somebody to debug.
    expect(normalizeCustomerId('696-268-5494')).toBe('6962685494');
    expect(normalizeCustomerId('6962685494')).toBe('6962685494');
  });

  it('refuses anything that is not ten digits', () => {
    expect(() => normalizeCustomerId('69626854')).toThrow(GaqlError);
    expect(() => normalizeCustomerId('not-an-id')).toThrow(GaqlError);
  });
});

describe('GAQL', () => {
  it('batches daily metrics by range, as §6 requires', () => {
    const soql = dailyMetricsQuery({ start: '2026-06-20', end: '2026-09-17' });
    expect(soql).toContain("WHERE segments.date BETWEEN '2026-06-20' AND '2026-09-17'");
    expect(soql).toContain('metrics.cost_micros');
  });

  it('refuses a backwards range', () => {
    expect(() => dailyMetricsQuery({ start: '2026-09-17', end: '2026-06-20' })).toThrow(
      /starts after it ends/,
    );
  });

  it('pins click_view to exactly one day', () => {
    // Not a tuning choice: the API rejects a range on this resource.
    const soql = clickViewQuery('2026-09-16');
    expect(soql).toContain("WHERE segments.date = '2026-09-16'");
    expect(soql).not.toContain('BETWEEN');
    expect(soql).toContain('click_view.gclid');
  });

  it('rejects a date that matches the pattern but is not a day', () => {
    expect(() => assertDay('2026-02-31')).toThrow(GaqlError);
    expect(() => assertDay('17-09-2026')).toThrow(GaqlError);
  });

  it('names the resources the other two queries need', () => {
    expect(campaignQuery()).toContain('FROM campaign');
    expect(accountQuery()).toContain('customer.time_zone');
  });
});

describe('the click_view window', () => {
  it('reaches back 90 days inclusive', () => {
    expect(earliestClickDay('2026-09-17')).toBe('2026-06-20');
    expect(isWithinClickWindow('2026-06-20', '2026-09-17')).toBe(true);
    expect(isWithinClickWindow('2026-06-19', '2026-09-17')).toBe(false);
  });

  it('excludes the future', () => {
    expect(isWithinClickWindow('2026-09-18', '2026-09-17')).toBe(false);
  });
});

describe('normalisation', () => {
  it('converts micros to currency units without rounding at ingest', () => {
    // 5_230_000 micros is $5.23. Rounding here rather than at render would lose
    // a fraction of a cent per row across a 90-day window.
    expect(fromMicros('5230000')).toBeCloseTo(5.23, 6);
    expect(fromMicros(1_234_567)).toBeCloseTo(1.234567, 6);
    expect(fromMicros(undefined)).toBe(0);
  });

  it('reads 64-bit counts that arrive as JSON strings', () => {
    const rows: GoogleAdsRow[] = [
      {
        campaign: { id: '111' },
        segments: { date: '2026-09-16' },
        metrics: { impressions: '4210', clicks: '87', costMicros: '5230000', conversions: 622.86 },
      },
    ];
    expect(normalizeDailyMetrics(rows)[0]).toEqual({
      date: '2026-09-16',
      externalCampaignId: '111',
      impressions: 4210,
      clicks: 87,
      spend: 5.23,
      // Left fractional: Google attributes conversions fractionally, and
      // rounding would make our total disagree with theirs permanently.
      platformConversions: 622.86,
    });
  });

  it('drops a metrics row with no date rather than guessing one', () => {
    // The date is the upsert key. A guess overwrites another day's spend.
    expect(normalizeDailyMetrics([{ campaign: { id: '1' }, metrics: { clicks: '5' } }])).toEqual([]);
  });

  it('drops a click with no gclid rather than writing an empty key', () => {
    const rows: GoogleAdsRow[] = [
      { clickView: { gclid: 'abc' }, campaign: { id: '111' }, segments: { date: '2026-09-16' } },
      { clickView: {}, campaign: { id: '111' }, segments: { date: '2026-09-16' } },
      { clickView: { gclid: '  ' }, segments: { date: '2026-09-16' } },
    ];
    expect(normalizeClicks(rows)).toEqual([
      {
        clickId: 'abc',
        reportedDate: '2026-09-16',
        externalCampaignId: '111',
        externalAdGroupId: null,
        adNetworkType: null,
        device: null,
      },
    ]);
  });

  it('keeps a campaign whose name is missing rather than dropping the row', () => {
    expect(normalizeCampaigns([{ campaign: { id: '77' } }])[0]).toMatchObject({
      externalCampaignId: '77',
      name: 'Campaign 77',
    });
  });

  it('reads the account', () => {
    expect(
      normalizeAccount({
        customer: { id: '1234567890', descriptiveName: 'Spartan', currencyCode: 'USD', timeZone: 'America/New_York' },
      }),
    ).toEqual({
      externalAccountId: '1234567890',
      name: 'Spartan',
      currency: 'USD',
      timeZone: 'America/New_York',
    });
  });
});

describe('reporting zone', () => {
  it('passes when the account and the tenant share a zone', () => {
    expect(checkReportingZone('America/New_York', 'America/New_York')).toEqual({
      aligned: true,
      zone: 'America/New_York',
    });
  });

  it('reports a mismatch rather than shifting the day', () => {
    // Daily spend arrives pre-aggregated on the account's boundary with no
    // finer grain to re-bucket from, so a shift would invent an hourly split.
    const zone = checkReportingZone('America/Los_Angeles', 'America/New_York');
    expect(zone.aligned).toBe(false);
    if (!zone.aligned) expect(zone.detail).toMatch(/cannot be re-bucketed/);
  });

  it('treats an unreported zone as unconfirmed, not as matching', () => {
    expect(checkReportingZone(null, 'America/New_York').aligned).toBe(false);
  });
});

describe('auth', () => {
  const okToken = () =>
    ({
      ok: true,
      json: async () => ({ access_token: 'ya29.token', expires_in: 3600 }),
    }) as unknown as Response;

  it('mints an access token and expires it a minute early', async () => {
    const now = new Date('2026-09-17T12:00:00Z');
    const token = await requestGoogleAdsAccessToken(CREDENTIALS, async () => okToken(), now);
    expect(token.accessToken).toBe('ya29.token');
    // 3600s minus a 60s margin: a sync must not discover expiry mid-pagination.
    expect(token.expiresAt).toEqual(new Date('2026-09-17T12:59:00Z'));
  });

  it('explains invalid_grant as the client’s to fix, not ours', async () => {
    const fetchImpl = async () =>
      ({ ok: false, json: async () => ({ error: 'invalid_grant' }) }) as unknown as Response;
    const error = await requestGoogleAdsAccessToken(CREDENTIALS, fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleAdsAuthError);
    expect((error as GoogleAdsAuthError).failure.waitingOnClient).toBe(true);
  });

  it('explains a Web-application client as ours to fix', async () => {
    const fetchImpl = async () =>
      ({ ok: false, json: async () => ({ error: 'unauthorized_client' }) }) as unknown as Response;
    const error = await requestGoogleAdsAccessToken(CREDENTIALS, fetchImpl).catch((e) => e);
    expect((error as GoogleAdsAuthError).failure.waitingOnClient).toBe(false);
  });

  it('omits the developer token, which Google sunset on 9 September 2026', () => {
    // Optional and ignored by their servers. Its absence is not a
    // misconfiguration, and no access level may be inferred from it.
    const headers = requestHeaders('ya29.token', CREDENTIALS, '6962685494');
    expect(headers['developer-token']).toBeUndefined();
    expect(headers['login-customer-id']).toBe('6962685494');
    expect(headers.authorization).toBe('Bearer ya29.token');
  });

  it('still sends a developer token when a legacy connection holds one', () => {
    const headers = requestHeaders('t', { ...CREDENTIALS, developerToken: 'legacy' });
    expect(headers['developer-token']).toBe('legacy');
  });

  it('omits login-customer-id when the account is queried directly', () => {
    expect(requestHeaders('t', CREDENTIALS)['login-customer-id']).toBeUndefined();
  });

  it('finds the Cloud project that now carries the access level', () => {
    expect(cloudProjectNumber(CREDENTIALS.clientId)).toBe('123456789012');
    expect(cloudProjectNumber('nonsense')).toBeNull();
  });
});

describe('the client', () => {
  function stub(response: Partial<Response> & { jsonBody?: unknown }) {
    return vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('oauth2')) {
        return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) } as Response;
      }
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        headers: { get: () => 'req-123' },
        json: async () => response.jsonBody,
        text: async () => JSON.stringify(response.jsonBody ?? ''),
      } as unknown as Response;
    });
  }

  it('flattens the searchStream chunk array', async () => {
    const fetchImpl = stub({
      jsonBody: [{ results: [{ campaign: { id: '1' } }] }, { results: [{ campaign: { id: '2' } }] }],
    });
    const client = new GoogleAdsClient(CREDENTIALS, { customerId: '1234567890' }, fetchImpl);
    expect(await client.search('SELECT campaign.id FROM campaign')).toHaveLength(2);
  });

  it('treats an empty result as a result, not a failure', async () => {
    const client = new GoogleAdsClient(CREDENTIALS, { customerId: '1234567890' }, stub({ jsonBody: [] }));
    expect(await client.search('SELECT campaign.id FROM campaign')).toEqual([]);
  });

  it('calls the configured API version against the right customer', async () => {
    const fetchImpl = stub({ jsonBody: [] });
    const client = new GoogleAdsClient(
      CREDENTIALS,
      { customerId: '696-268-5494', apiVersion: 'v25' },
      fetchImpl,
    );
    await client.search('SELECT campaign.id FROM campaign');
    const called = fetchImpl.mock.calls.find((c) => String(c[0]).includes('googleads.googleapis'));
    expect(String(called?.[0])).toBe(
      'https://googleads.googleapis.com/v25/customers/6962685494/googleAds:searchStream',
    );
  });

  it('names the Cloud project when access is refused', async () => {
    // Since the developer-token sunset the access level hangs off the Cloud
    // project, and nothing in the response says which one.
    const fetchImpl = stub({ ok: false, status: 403, jsonBody: { error: 'CUSTOMER_NOT_ENABLED' } });
    const client = new GoogleAdsClient(CREDENTIALS, { customerId: '1234567890' }, fetchImpl);
    const error = await client.search('SELECT campaign.id FROM campaign').catch((e) => e);
    expect(error).toBeInstanceOf(GoogleAdsAccessError);
    expect((error as GoogleAdsAccessError).remedy).toContain('123456789012');
    expect((error as GoogleAdsAccessError).remedy).toContain('Cloud Console');
  });

  it('marks quota and server errors retryable, and a bad query not', async () => {
    const quota = new GoogleAdsClient(
      CREDENTIALS,
      { customerId: '1234567890' },
      stub({ ok: false, status: 429, jsonBody: { error: 'RESOURCE_EXHAUSTED' } }),
    );
    const bad = new GoogleAdsClient(
      CREDENTIALS,
      { customerId: '1234567890' },
      stub({ ok: false, status: 400, jsonBody: { error: 'BAD_FIELD' } }),
    );
    const quotaError = await quota.search('x').catch((e) => e);
    const badError = await bad.search('x').catch((e) => e);
    expect((quotaError as GoogleAdsApiError).retryable).toBe(true);
    expect((badError as GoogleAdsApiError).retryable).toBe(false);
  });
});

describe('the connector', () => {
  function connectorWith(rowsFor: (query: string) => GoogleAdsRow[]) {
    return googleAdsConnector(
      () =>
        ({
          search: async (query: string) => rowsFor(query),
        }) as unknown as GoogleAdsClient,
    );
  }

  it('reports healthy on an aligned account', async () => {
    const connector = connectorWith(() => [
      { customer: { id: '1', descriptiveName: 'Spartan', timeZone: 'America/New_York' } },
    ]);
    expect(await connector.testConnection(CONNECTION)).toMatchObject({
      state: 'healthy',
      accountName: 'Spartan',
    });
  });

  it('reports degraded, not healthy, when day boundaries differ', async () => {
    const connector = connectorWith(() => [
      { customer: { id: '1', descriptiveName: 'Spartan', timeZone: 'America/Los_Angeles' } },
    ]);
    const health = await connector.testConnection(CONNECTION);
    expect(health.state).toBe('degraded');
  });

  it('refuses a day outside the window before spending a request on it', async () => {
    // The caller has to tell "ask again later" from "gone for good", and an API
    // error for an aged-out day does not say which.
    const search = vi.fn(async () => []);
    const connector = googleAdsConnector(() => ({ search }) as unknown as GoogleAdsClient);
    const error = await connector.fetchClicks!(CONNECTION, '2020-01-01').catch((e) => e);
    expect(error).toBeInstanceOf(ClickWindowExpiredError);
    expect(search).not.toHaveBeenCalled();
  });

  it('fetches a day inside the window', async () => {
    // The tenant's today, not UTC's. `fetchClicks` compares the requested day
    // against `todayInZone(conn.tenantTimezone)`, so a UTC date is a day in the
    // future for four hours every night in America/New_York — and this test
    // failed every run between midnight and 4am UTC for that reason alone.
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONNECTION.tenantTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const connector = connectorWith(() => [
      { clickView: { gclid: 'g1' }, campaign: { id: '9' }, segments: { date: today } },
    ]);
    const clicks = await connector.fetchClicks!(CONNECTION, today);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ clickId: 'g1', externalCampaignId: '9' });
  });
});
