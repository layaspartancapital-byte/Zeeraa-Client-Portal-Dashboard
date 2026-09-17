import { NonRetriableError } from 'inngest';
import { SalesforceAuthError } from '@zeeraa/connectors';
import { inngest, RETRIES, type BackfillRequested, type SyncRequested } from './client';
import { listSalesforceConnections, resolveSalesforceContext } from '../salesforce/context';
import { runSalesforceSync } from '../salesforce/sync';
import { backfillClickIdsFromConvertedLeads } from '../salesforce/backfill';
import { listGoogleAdsConnections, resolveGoogleAdsContext } from '../google-ads/context';
import { runGoogleAdsSync } from '../google-ads/sync';

/**
 * Hourly incremental sync on SystemModstamp (§7).
 *
 * `concurrency` is keyed on the tenant so two runs for one client cannot
 * overlap and fight over the same watermark, while different clients still sync
 * in parallel.
 */
export const salesforceSync = inngest.createFunction(
  {
    id: 'salesforce-sync',
    retries: RETRIES,
    concurrency: { key: 'event.data.tenantId', limit: 1 },
    triggers: [{ event: 'salesforce/sync.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as SyncRequested;

    return step.run('sync', async () => {
      const context = await resolveSalesforceContext(data.tenantId, data.connectionId);
      try {
        return await runSalesforceSync(context, { trigger: data.trigger ?? 'scheduled' });
      } catch (error) {
        // An org misconfiguration will not fix itself on the third attempt, and
        // retrying buries it under noise. Surface it instead.
        if (error instanceof SalesforceAuthError && error.failure.waitingOnClient) {
          throw new NonRetriableError(error.message, { cause: error });
        }
        throw error;
      }
    });
  },
);

export const salesforceSyncSchedule = inngest.createFunction(
  {
    id: 'salesforce-sync-schedule',
    triggers: [{ cron: 'TZ=America/New_York 0 * * * *' }],
  },
  async ({ step }) => {
    const connections = await step.run('list-connections', () => listSalesforceConnections());

    for (const connection of connections) {
      await step.sendEvent(`sync-${connection.tenantId}`, {
        name: 'salesforce/sync.requested',
        data: { ...connection, trigger: 'hourly' } satisfies SyncRequested,
      });
    }
    return { dispatched: connections.length };
  },
);

/**
 * The converted-Lead click-ID backfill, on demand.
 *
 * Its own function rather than a step of the sync: it walks history rather than
 * a window, so it runs on a different cadence and has to be re-runnable without
 * waiting for an hourly tick.
 */
export const salesforceBackfill = inngest.createFunction(
  {
    id: 'salesforce-backfill-click-ids',
    retries: RETRIES,
    concurrency: { key: 'event.data.tenantId', limit: 1 },
    triggers: [{ event: 'salesforce/backfill.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as BackfillRequested;

    return step.run('backfill', async () => {
      const context = await resolveSalesforceContext(data.tenantId, data.connectionId);
      return backfillClickIdsFromConvertedLeads({
        tenantId: context.tenantId,
        client: context.client,
        mapping: context.mapping,
        since: data.since ? new Date(data.since) : undefined,
        limit: data.limit,
      });
    });
  },
);


/**
 * The nightly Google Ads sync (§7).
 *
 * `concurrency` is keyed on the tenant so two runs for one client cannot
 * overlap and fight over the same click-day ledger, while different clients
 * still sync in parallel.
 */
export const googleAdsSync = inngest.createFunction(
  {
    id: 'google-ads-sync',
    retries: RETRIES,
    concurrency: { key: 'event.data.tenantId', limit: 1 },
    triggers: [{ event: 'google-ads/sync.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as { tenantId: string; connectionId: string; trigger?: string };

    return step.run('sync', async () => {
      const context = await resolveGoogleAdsContext(data.tenantId, data.connectionId);
      return runGoogleAdsSync(context, { trigger: data.trigger ?? 'nightly' });
    });
  },
);

export const googleAdsSyncSchedule = inngest.createFunction(
  {
    id: 'google-ads-sync-schedule',
    triggers: [{ cron: 'TZ=America/New_York 0 3 * * *' }],
  },
  async ({ step }) => {
    const connections = await step.run('list-connections', () => listGoogleAdsConnections());

    for (const connection of connections) {
      await step.sendEvent(`google-ads-${connection.tenantId}`, {
        name: 'google-ads/sync.requested',
        data: { ...connection, trigger: 'nightly' },
      });
    }
    return { dispatched: connections.length };
  },
);

export const functions = [
  salesforceSync,
  salesforceSyncSchedule,
  salesforceBackfill,
  googleAdsSync,
  googleAdsSyncSchedule,
];
