/**
 * Runs the scheduled syncs for every tenant, without Inngest.
 *
 *   pnpm --filter @zeeraa/jobs run-scheduled nightly   # ads: 90-day window
 *   pnpm --filter @zeeraa/jobs run-scheduled hourly    # Salesforce incremental
 *
 * Routine hourly syncing is Vercel Cron's job now — `/api/cron/sync`, which
 * runs `runIncrementalSync` inside a 60-second function: two days of paid media
 * and Salesforce since its last completed read.
 *
 * This script is the other half, and it stays. It re-pulls the full ninety-day
 * window, which does not fit in a serverless function: ninety days of
 * `click_view` is ninety sequential requests. That matters because the window
 * expires — Google serves ninety days of click data and then stops, so a day
 * nobody captured is a day of attribution no later run recovers. Run this after
 * a long outage, after first connecting a platform, and whenever the hourly
 * endpoint reports that it skipped Salesforce because the change window was too
 * wide to attempt.
 *
 * It calls exactly the same sync functions the endpoint calls, so the two
 * cannot drift.
 *
 * Failures are per tenant and per platform. One client's revoked credential
 * must not stop another client's window from being captured, so every unit is
 * caught, reported and counted, and the process exits non-zero at the end
 * rather than at the first problem.
 */
import { listGoogleAdsConnections, resolveGoogleAdsContext } from '../src/google-ads/context';
import { runGoogleAdsSync } from '../src/google-ads/sync';
import { listMetaConnections, resolveMetaContext } from '../src/meta/context';
import { runMetaSync } from '../src/meta/sync';
import { listSalesforceConnections, resolveSalesforceContext } from '../src/salesforce/context';
import { runSalesforceSync } from '../src/salesforce/sync';
import { backfillClickIdsFromConvertedLeads } from '../src/salesforce/backfill';

type Cadence = 'nightly' | 'hourly';

const cadence = (process.argv[2] ?? 'nightly') as Cadence;
if (cadence !== 'nightly' && cadence !== 'hourly') {
  throw new Error('Usage: tsx scripts/run-scheduled.ts <nightly|hourly>');
}

const startedAt = new Date();
const failures: string[] = [];
let units = 0;

function log(line: string) {
  console.log(`${new Date().toISOString()}  ${line}`);
}

async function attempt(label: string, fn: () => Promise<string>): Promise<void> {
  units += 1;
  try {
    log(`${label}: start`);
    log(`${label}: ${await fn()}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    log(`${label}: FAILED — ${message}`);
  }
}

try {
  log(`run-scheduled ${cadence}`);

  if (cadence === 'hourly') {
    for (const connection of await listSalesforceConnections()) {
      await attempt(`salesforce ${connection.tenantId.slice(0, 8)}`, async () => {
        const context = await resolveSalesforceContext(
          connection.tenantId,
          connection.connectionId,
        );
        const result = await runSalesforceSync(context, { trigger: 'hourly' });
        return (
          `${result.status} — ${result.leads} leads, ${result.opportunities} opportunities, ` +
          `${result.stageEvents} stage events`
        );
      });
    }
  }

  if (cadence === 'nightly') {
    // Ads first. The click window is the only thing here with an expiry on it,
    // so it runs before anything that could fail and stop the run.
    for (const connection of await listGoogleAdsConnections()) {
      await attempt(`google-ads ${connection.tenantId.slice(0, 8)}`, async () => {
        const context = await resolveGoogleAdsContext(connection.tenantId, connection.connectionId);
        const result = await runGoogleAdsSync(context, { trigger: 'nightly' });
        const clicks = result.clicks;
        if (clicks.daysExpired > 0) {
          // Not a failure — no retry recovers it — but the one line in this log
          // that somebody has to act on, because it means the schedule was not
          // running when it should have been.
          log(
            `  WARNING: ${clicks.daysExpired} click ${
              clicks.daysExpired === 1 ? 'day' : 'days'
            } aged out of the window uningested and cannot be recovered.`,
          );
        }
        return (
          `${result.status} — ${result.campaigns} campaigns, ${result.dailyMetrics} metric rows, ` +
          `${clicks.daysSucceeded}/${clicks.daysAttempted} click days, ` +
          `${clicks.clicksWritten} clicks, ${clicks.daysRemaining} outstanding`
        );
      });
    }

    // Then Meta. No click ledger, so nothing here expires and it can follow the
    // one thing that does.
    for (const connection of await listMetaConnections()) {
      await attempt(`meta ${connection.tenantId.slice(0, 8)}`, async () => {
        const context = await resolveMetaContext(connection.tenantId, connection.connectionId);
        const result = await runMetaSync(context, { trigger: 'nightly' });
        if (result.accountWarning) log(`  NOTE: ${result.accountWarning}`);
        return `${result.status} — ${result.campaigns} campaigns, ${result.dailyMetrics} metric rows`;
      });
    }

    // Then Salesforce, so the join at the end of the ads sync has the freshest
    // CRM side the next run will use.
    for (const connection of await listSalesforceConnections()) {
      await attempt(`salesforce ${connection.tenantId.slice(0, 8)}`, async () => {
        const context = await resolveSalesforceContext(
          connection.tenantId,
          connection.connectionId,
        );
        const sync = await runSalesforceSync(context, { trigger: 'nightly' });
        const backfill = await backfillClickIdsFromConvertedLeads({
          tenantId: context.tenantId,
          client: context.client,
          mapping: context.mapping,
        });
        return (
          `${sync.status} — ${sync.leads} leads, ${sync.opportunities} opportunities, ` +
          `${sync.stageEvents} stage events, ${backfill.clickIdsRecovered} click ids recovered`
        );
      });
    }
  }

  const seconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  log(`done in ${seconds}s — ${units - failures.length}/${units} succeeded`);
  if (failures.length > 0) {
    log(`${failures.length} failed:`);
    for (const failure of failures) log(`  ${failure}`);
    process.exitCode = 1;
  }
} finally {
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
