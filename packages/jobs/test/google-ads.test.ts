/**
 * The Google Ads ingest and join, against a real Postgres and a stub connector.
 *
 * No credential is involved. The connector is replaced by a stub that returns
 * captured response shapes, which is the point: everything below the API
 * boundary is finished and provable before the handover.
 *
 * These run through `withJobTenant`, so they exercise the ingestion role's
 * policies at the same time — a write the policies would refuse fails here
 * rather than in production at 3am.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, withJobTenant, type Database } from '@zeeraa/db';
import { ClickWindowExpiredError, type ClickRow, type Connection, type Connector } from '@zeeraa/connectors';
import { clickCoverage, ingestClicks, planClickDays } from '../src/google-ads/clicks';
import { buildAttribution, gatherTouches, spendToFunded } from '../src/google-ads/join';
import { upsertAdClicks, upsertCampaigns, upsertDailyMetrics } from '../src/google-ads/writer';
import { openSyncRun } from '../src/sync-runs';

const OWNER_URL =
  process.env.DATABASE_URL_OWNER ?? 'postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa';
const JOBS_URL =
  process.env.DATABASE_URL_JOBS ??
  'postgres://zeeraa_jobs_runner:zeeraa_jobs_runner@localhost:5433/zeeraa';

const ownerSql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const owner = drizzle(ownerSql, { schema }) as unknown as Database;
const jobsSql = postgres(JOBS_URL, { max: 2, prepare: false, onnotice: () => {} });
const jobs = drizzle(jobsSql, { schema }) as unknown as Database;

let tenantId: string;
let syncRunId: string;

const inTenant = <T>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn, jobs);

const CONNECTION = {
  id: 'conn',
  tenantId: '',
  platform: 'google_ads',
  accountIdentifier: '1234567890',
  credentials: {},
  config: { customerId: '1234567890' },
  tenantTimezone: 'America/New_York',
  tenantCurrency: 'USD',
} as Connection;

/** A connector whose clicks come from a table, not an API. */
function stubConnector(
  byDay: Record<string, ClickRow[]>,
  failOn: Record<string, Error> = {},
): Connector {
  return {
    key: 'google_ads',
    label: 'Google Ads',
    testConnection: async () => ({ state: 'healthy' }),
    fetchDailyMetrics: async () => [],
    fetchClicks: vi.fn(async (_conn: Connection, day: string) => {
      const failure = failOn[day];
      if (failure) throw failure;
      return byDay[day] ?? [];
    }),
  };
}

const click = (clickId: string, reportedDate: string, campaign = '111'): ClickRow => ({
  clickId,
  reportedDate,
  externalCampaignId: campaign,
  externalAdGroupId: null,
  adNetworkType: 'SEARCH',
  device: 'MOBILE',
});

beforeAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance', 'on', true)`;
    const [t] = await tx`
      insert into tenants (name, slug) values ('GAds Test', ${'gads-' + Date.now()})
      returning id
    `;
    tenantId = t!.id as string;
    CONNECTION.tenantId = tenantId;
    const [r] = await tx`
      insert into sync_runs (tenant_id, platform, trigger, status)
      values (${tenantId}, 'google_ads', 'test', 'running') returning id
    `;
    syncRunId = r!.id as string;
    await tx`
      insert into funnel_stages (tenant_id, position, key, label, counts_value)
      values (${tenantId}, 1, 'funded', 'Funded', true)
    `;
  });
});

beforeEach(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance', 'on', true)`;
    await tx`delete from attribution where tenant_id = ${tenantId}`;
    await tx`delete from ad_clicks where tenant_id = ${tenantId}`;
    await tx`delete from click_ingest_days where tenant_id = ${tenantId}`;
    await tx`delete from daily_metrics where tenant_id = ${tenantId}`;
    await tx`delete from stage_events where tenant_id = ${tenantId}`;
    await tx`delete from opportunity_click_ids where tenant_id = ${tenantId}`;
    await tx`delete from opportunities where tenant_id = ${tenantId}`;
    await tx`delete from leads where tenant_id = ${tenantId}`;
    await tx`delete from campaigns where tenant_id = ${tenantId}`;
  });
});

afterAll(async () => {
  await ownerSql.begin(async (tx) => {
    await tx`select set_config('app.maintenance', 'on', true)`;
    await tx`delete from tenants where id = ${tenantId}`;
  });
  await Promise.all([ownerSql.end(), jobsSql.end()]);
});

async function seedCampaign(): Promise<Map<string, string>> {
  return inTenant((tx) =>
    upsertCampaigns(tx, tenantId, 'google_ads', [
      { externalCampaignId: '111', name: 'Search — MCA', status: 'ENABLED' },
    ]),
  );
}

describe('the writers', () => {
  it('upserts daily metrics rather than appending on a re-pull', async () => {
    // The nightly job re-pulls a trailing 90 days because Google restates
    // conversions for 30+ days. An append would multiply every restatement.
    const campaigns = await seedCampaign();
    const row = {
      date: '2026-09-16',
      externalCampaignId: '111',
      impressions: 100,
      clicks: 10,
      spend: 5.23,
      platformConversions: 1.5,
    };
    await inTenant((tx) => upsertDailyMetrics(tx, tenantId, 'google_ads', [row], campaigns, syncRunId));
    await inTenant((tx) =>
      upsertDailyMetrics(tx, tenantId, 'google_ads', [{ ...row, spend: 7.5 }], campaigns, syncRunId),
    );

    const rows = await inTenant((tx) => tx.select().from(schema.dailyMetrics));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.spend)).toBeCloseTo(7.5, 4);
  });

  it('deduplicates account-level rows, whose campaign is null', async () => {
    // The unique index coalesces the null; a plain constraint would let nulls
    // collide freely and the re-pull would append.
    const row = {
      date: '2026-09-16',
      externalCampaignId: null,
      impressions: 5,
      clicks: 1,
      spend: 1,
      platformConversions: 0,
    };
    await inTenant((tx) => upsertDailyMetrics(tx, tenantId, 'google_ads', [row], new Map(), syncRunId));
    await inTenant((tx) => upsertDailyMetrics(tx, tenantId, 'google_ads', [row], new Map(), syncRunId));
    expect(await inTenant((tx) => tx.select().from(schema.dailyMetrics))).toHaveLength(1);
  });

  it('keeps spend whose campaign is unknown rather than dropping it', async () => {
    // The spend happened and belongs in the account total. Dropping it would
    // make the platform disagree with Google's own UI.
    await inTenant((tx) =>
      upsertDailyMetrics(
        tx,
        tenantId,
        'google_ads',
        [
          {
            date: '2026-09-16',
            externalCampaignId: '999',
            impressions: 1,
            clicks: 1,
            spend: 9,
            platformConversions: 0,
          },
        ],
        new Map(),
        syncRunId,
      ),
    );
    const rows = await inTenant((tx) => tx.select().from(schema.dailyMetrics));
    expect(rows[0]!.campaignId).toBeNull();
    expect(Number(rows[0]!.spend)).toBe(9);
  });

  it('does not overwrite Zeeraa’s own campaign classification', async () => {
    // product/industry/keyword_tier are our categorisation, not the platform's.
    await seedCampaign();
    await inTenant((tx) =>
      tx
        .update(schema.campaigns)
        .set({ product: 'MCA', keywordTier: 'brand' })
        .where(eq(schema.campaigns.tenantId, tenantId)),
    );
    await inTenant((tx) =>
      upsertCampaigns(tx, tenantId, 'google_ads', [
        { externalCampaignId: '111', name: 'Search — MCA (renamed)', status: 'PAUSED' },
      ]),
    );
    const [row] = await inTenant((tx) => tx.select().from(schema.campaigns));
    expect(row!.name).toBe('Search — MCA (renamed)');
    expect(row!.product).toBe('MCA');
    expect(row!.keywordTier).toBe('brand');
  });

  it('collapses a gclid returned twice in one day', async () => {
    // Postgres refuses an ON CONFLICT that hits one row twice in a statement.
    const campaigns = await seedCampaign();
    const written = await inTenant((tx) =>
      upsertAdClicks(
        tx,
        tenantId,
        'google_ads',
        [click('g1', '2026-09-16'), click('g1', '2026-09-16')],
        campaigns,
        syncRunId,
      ),
    );
    expect(written).toBe(1);
  });
});

describe('the click-day ledger', () => {
  const today = '2026-09-17';

  it('records every day in the window before fetching anything', async () => {
    // A run that dies on its first request still has to leave behind a record
    // of what it intended to do.
    const plan = await inTenant((tx) =>
      planClickDays(tx, tenantId, 'google_ads', { start: '2026-09-14', end: '2026-09-17' }, today),
    );
    expect(plan.pending).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
    expect(await inTenant((tx) => tx.select().from(schema.clickIngestDays))).toHaveLength(4);
  });

  it('marks days past the 90-day edge expired, not failed', async () => {
    // Different facts: one is a job to retry, the other is a hole no retry
    // fills. Conflating them retries 90 impossible requests every night.
    const plan = await inTenant((tx) =>
      planClickDays(tx, tenantId, 'google_ads', { start: '2026-06-18', end: '2026-06-21' }, today),
    );
    expect(plan.expired).toEqual(['2026-06-18', '2026-06-19']);
    expect(plan.pending).toEqual(['2026-06-20', '2026-06-21']);

    const rows = await inTenant((tx) =>
      tx
        .select()
        .from(schema.clickIngestDays)
        .where(eq(schema.clickIngestDays.status, 'expired')),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.lastError).toMatch(/not recoverable/);
  });

  it('resumes rather than restarting, and is idempotent per day', async () => {
    // Deliberately settled days — inside the 90-day window, outside the 7-day
    // re-pull window — so this isolates resumption from the settling rule.
    const days = { '2026-07-15': [click('g1', '2026-07-15')], '2026-07-16': [click('g2', '2026-07-16')] };
    const range = { start: '2026-07-15', end: '2026-07-16' };
    await seedCampaign();

    // First run fails on the 16th.
    const failing = stubConnector(days, { '2026-07-16': new Error('RESOURCE_EXHAUSTED') });
    const first = await ingestClicks(
      inTenant,
      { tenantId, platform: 'google_ads', connection: CONNECTION, connector: failing, syncRunId, today },
      range,
    );
    expect(first).toMatchObject({ daysSucceeded: 1, daysFailed: 1, clicksWritten: 1 });

    // Second run picks up only the failed day.
    const healthy = stubConnector(days);
    const second = await ingestClicks(
      inTenant,
      { tenantId, platform: 'google_ads', connection: CONNECTION, connector: healthy, syncRunId, today },
      range,
    );
    expect(second.daysSucceeded).toBe(1);
    expect(healthy.fetchClicks).toHaveBeenCalledTimes(1);
    expect(healthy.fetchClicks).toHaveBeenCalledWith(CONNECTION, '2026-07-16');

    // Both days' clicks are present exactly once.
    expect(await inTenant((tx) => tx.select().from(schema.adClicks))).toHaveLength(2);
    expect(await inTenant((tx) => clickCoverage(tx, tenantId, 'google_ads'))).toMatchObject({
      succeeded: 2,
      failed: 0,
    });
  });

  it('re-pulls a settled day only when it is still settling', async () => {
    // Google restates for weeks, so the trailing window is re-read; an older
    // succeeded day is not.
    const days = { '2026-06-25': [click('old', '2026-06-25')], '2026-09-16': [click('new', '2026-09-16')] };
    const connector = stubConnector(days);
    const range = { start: '2026-06-25', end: '2026-09-16' };

    await ingestClicks(
      inTenant,
      { tenantId, platform: 'google_ads', connection: CONNECTION, connector, syncRunId, today },
      range,
    );
    vi.mocked(connector.fetchClicks!).mockClear();

    await ingestClicks(
      inTenant,
      { tenantId, platform: 'google_ads', connection: CONNECTION, connector, syncRunId, today },
      range,
    );
    const asked = vi.mocked(connector.fetchClicks!).mock.calls.map((c) => c[1]);
    expect(asked).toContain('2026-09-16');
    expect(asked).not.toContain('2026-06-25');
  });

  it('honours a per-run day budget and reports what is left', async () => {
    // An Explorer-level Cloud project gets 2,880 operations a day, so a 90-day
    // backfill spreads over several nights rather than failing at the quota.
    const connector = stubConnector({});
    const result = await ingestClicks(
      inTenant,
      {
        tenantId,
        platform: 'google_ads',
        connection: CONNECTION,
        connector,
        syncRunId,
        today,
        maxDays: 2,
      },
      { start: '2026-09-12', end: '2026-09-17' },
    );
    expect(result.daysAttempted).toBe(2);
    expect(result.daysRemaining).toBe(4);
  });

  it('records a day that ages out mid-run as expired, not failed', async () => {
    const connector = stubConnector(
      {},
      { '2026-09-15': new ClickWindowExpiredError('2026-09-15', '2026-06-20') },
    );
    const result = await ingestClicks(
      inTenant,
      { tenantId, platform: 'google_ads', connection: CONNECTION, connector, syncRunId, today },
      { start: '2026-09-15', end: '2026-09-15' },
    );
    expect(result).toMatchObject({ daysExpired: 1, daysFailed: 0, daysAttempted: 0 });
  });
});

describe('the spend-to-funded join', () => {
  async function seedOpportunityWithClick(clickId: string, opportunityId = 'OPP-1') {
    await inTenant(async (tx) => {
      await tx.insert(schema.opportunities).values({
        tenantId,
        externalId: opportunityId,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        currentStage: 'funded',
      });
      await tx.insert(schema.opportunityClickIds).values({
        tenantId,
        opportunityExternalId: opportunityId,
        platform: 'google_ads',
        clickId,
        source: 'opportunity_field',
      });
    });
  }

  it('joins a click to its campaign and writes both models', async () => {
    const campaigns = await seedCampaign();
    await inTenant((tx) =>
      upsertAdClicks(tx, tenantId, 'google_ads', [click('g1', '2026-09-12')], campaigns, syncRunId),
    );
    await seedOpportunityWithClick('g1');

    const result = await inTenant((tx) => buildAttribution(tx, tenantId));
    expect(result.opportunities).toBe(1);
    expect(result.attributionRows).toBe(2);
    expect(result.coverage.last_touch.attributed).toBe(1);

    const rows = await inTenant((tx) => tx.select().from(schema.attribution));
    expect(rows.map((r) => r.model).sort()).toEqual(['first_touch', 'last_touch']);
    expect(rows.every((r) => r.campaignId === campaigns.get('111'))).toBe(true);
  });

  it('reports a click with no ad_clicks row as unattributed, not as no click', async () => {
    // This is what an aged-out click looks like: the CRM remembers it and
    // Google no longer will. The deal came from paid and cannot be proven to.
    await seedOpportunityWithClick('aged-out');
    const result = await inTenant((tx) => buildAttribution(tx, tenantId));
    expect(result.coverage.last_touch).toMatchObject({
      attributed: 0,
      clickWithoutCampaign: 1,
      noTouches: 0,
    });
  });

  it('unions the click-id table and the converted-lead route without double counting', async () => {
    const campaigns = await seedCampaign();
    await inTenant((tx) =>
      upsertAdClicks(tx, tenantId, 'google_ads', [click('g1', '2026-09-12')], campaigns, syncRunId),
    );
    await seedOpportunityWithClick('g1');
    await inTenant((tx) =>
      tx.insert(schema.leads).values({
        tenantId,
        externalId: 'LEAD-1',
        createdAt: new Date('2026-09-09T00:00:00Z'),
        createdOn: '2026-09-08',
        clickId: 'g1',
        clickIdType: 'google_ads',
        convertedOpportunityId: 'OPP-1',
      }),
    );

    const touches = await inTenant((tx) => gatherTouches(tx, tenantId));
    expect(touches.get('OPP-1')).toHaveLength(1);
  });

  it('credits a deal with no paid touch to organic search only on its lead\'s proof', async () => {
    const organicLead = (externalId: string, opportunityId: string, channel: string | null) =>
      inTenant(async (tx) => {
        await tx.insert(schema.opportunities).values({
          tenantId,
          externalId: opportunityId,
          createdAt: new Date('2026-09-10T00:00:00Z'),
          currentStage: 'funded',
        });
        await tx.insert(schema.leads).values({
          tenantId,
          externalId,
          createdAt: new Date('2026-09-09T00:00:00Z'),
          createdOn: '2026-09-08',
          referrerUrl: 'https://www.google.com/',
          channel,
          convertedOpportunityId: opportunityId,
        });
      });
    await organicLead('LEAD-O', 'OPP-O', 'organic_search');
    await organicLead('LEAD-N', 'OPP-N', null);

    await inTenant((tx) => buildAttribution(tx, tenantId));
    const byDeal = async () =>
      Object.fromEntries(
        (await inTenant((tx) => tx.select().from(schema.attribution)))
          .filter((r) => r.model === 'last_touch')
          .map((r) => [r.opportunityExternalId, r.platform]),
      );
    // No proof, no row: the deal stays unattributed rather than organic.
    expect(await byDeal()).toEqual({ 'OPP-O': 'organic_search' });

    // Losing the proof removes the credit: the deal falls back to unattributed.
    await inTenant((tx) => tx.update(schema.leads).set({ channel: null }).where(eq(schema.leads.externalId, 'LEAD-O')));
    await inTenant((tx) => buildAttribution(tx, tenantId));
    expect(await byDeal()).toEqual({});

    // A paid touch outranks it, proof or not.
    await inTenant((tx) =>
      tx.update(schema.leads).set({ channel: 'organic_search' }).where(eq(schema.leads.externalId, 'LEAD-O')),
    );
    const campaigns = await seedCampaign();
    await inTenant((tx) =>
      upsertAdClicks(tx, tenantId, 'google_ads', [click('g9', '2026-09-12')], campaigns, syncRunId),
    );
    await inTenant((tx) =>
      tx.insert(schema.opportunityClickIds).values({
        tenantId,
        opportunityExternalId: 'OPP-O',
        platform: 'google_ads',
        clickId: 'g9',
        source: 'opportunity_field',
      }),
    );
    await inTenant((tx) => buildAttribution(tx, tenantId));
    expect(await byDeal()).toEqual({ 'OPP-O': 'google_ads' });
  });

  it('is idempotent: rebuilding attribution does not duplicate rows', async () => {
    const campaigns = await seedCampaign();
    await inTenant((tx) =>
      upsertAdClicks(tx, tenantId, 'google_ads', [click('g1', '2026-09-12')], campaigns, syncRunId),
    );
    await seedOpportunityWithClick('g1');
    await inTenant((tx) => buildAttribution(tx, tenantId));
    await inTenant((tx) => buildAttribution(tx, tenantId));
    expect(await inTenant((tx) => tx.select().from(schema.attribution))).toHaveLength(2);
  });

  it('computes cost per funded deal with the unattributed shares beside it', async () => {
    const campaigns = await seedCampaign();
    const campaignId = campaigns.get('111')!;
    await inTenant((tx) =>
      upsertAdClicks(tx, tenantId, 'google_ads', [click('g1', '2026-09-12')], campaigns, syncRunId),
    );
    await seedOpportunityWithClick('g1');
    await inTenant((tx) => buildAttribution(tx, tenantId));

    await inTenant(async (tx) => {
      await upsertDailyMetrics(
        tx,
        tenantId,
        'google_ads',
        [
          { date: '2026-09-12', externalCampaignId: '111', impressions: 0, clicks: 0, spend: 4_500, platformConversions: 0 },
          { date: '2026-09-12', externalCampaignId: null, impressions: 0, clicks: 0, spend: 500, platformConversions: 0 },
        ],
        campaigns,
        syncRunId,
      );
      await tx.insert(schema.stageEvents).values({
        tenantId,
        opportunityExternalId: 'OPP-1',
        stage: 'funded',
        occurredAt: new Date('2026-09-14T12:00:00Z'),
        occurredOn: '2026-09-14',
      });
    });

    const result = await inTenant((tx) =>
      spendToFunded(tx, tenantId, 'google_ads', { start: '2026-09-01', end: '2026-09-30' }, 'last_touch'),
    );
    // The channel's whole spend, account-level included: 4,500 on the campaign
    // plus 500 that resolved to none. Account-level spend is still Google Ads
    // spend, and leaving it out of the numerator would understate what the
    // channel cost by exactly the amount hardest to attribute.
    expect(result.channelSpend).toBe(5_000);
    expect(result.attributedDeals).toBe(1);
    expect(result.value).toBe(5_000);
    // The per-campaign breakdown still divides a campaign's own spend by the
    // deals attributed to that campaign.
    expect(result.byCampaign.find((c) => c.campaignId === campaignId)?.costPerFundedDeal).toBe(4_500);
  });

  it('counts a deal once even when the funded stage recurs', async () => {
    const campaigns = await seedCampaign();
    await inTenant((tx) =>
      upsertAdClicks(tx, tenantId, 'google_ads', [click('g1', '2026-09-12')], campaigns, syncRunId),
    );
    await seedOpportunityWithClick('g1');
    await inTenant((tx) => buildAttribution(tx, tenantId));
    await inTenant(async (tx) => {
      await upsertDailyMetrics(
        tx,
        tenantId,
        'google_ads',
        [{ date: '2026-09-12', externalCampaignId: '111', impressions: 0, clicks: 0, spend: 1_000, platformConversions: 0 }],
        campaigns,
        syncRunId,
      );
      await tx.insert(schema.stageEvents).values([
        { tenantId, opportunityExternalId: 'OPP-1', stage: 'funded', occurredAt: new Date('2026-09-14T12:00:00Z'), occurredOn: '2026-09-14' },
        { tenantId, opportunityExternalId: 'OPP-1', stage: 'funded', occurredAt: new Date('2026-09-20T12:00:00Z'), occurredOn: '2026-09-20' },
      ]);
    });

    const result = await inTenant((tx) =>
      spendToFunded(tx, tenantId, 'google_ads', { start: '2026-09-01', end: '2026-09-30' }, 'last_touch'),
    );
    expect(result.attributedDeals).toBe(1);
    expect(result.value).toBe(1_000);
  });

  it('returns a null cost per funded deal when nothing funded, not zero', async () => {
    const campaigns = await seedCampaign();
    await inTenant((tx) =>
      upsertDailyMetrics(
        tx,
        tenantId,
        'google_ads',
        [{ date: '2026-09-12', externalCampaignId: '111', impressions: 0, clicks: 0, spend: 900, platformConversions: 0 }],
        campaigns,
        syncRunId,
      ),
    );
    const result = await inTenant((tx) =>
      spendToFunded(tx, tenantId, 'google_ads', { start: '2026-09-01', end: '2026-09-30' }, 'last_touch'),
    );
    expect(result.value).toBeNull();
    expect(result.channelSpend).toBe(900);
  });
});
