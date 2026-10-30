import 'server-only';
import { cached, cachedByDigest, cachedReport } from '@/lib/report-cache';
import * as reporting from '@/lib/reporting';
import * as dashboard from '@/lib/dashboard';
import * as coverage from '@/lib/coverage';
import * as breakdown from '@/lib/breakdown';
import * as quality from '@/lib/quality-measures';
import * as platforms from '@/lib/platforms';
import * as tenant from '@/lib/tenant';
import * as seo from '@/lib/seo';
import * as platform from '@/lib/platform';
import * as organic from '@/lib/organic';

/**
 * The report functions the dashboard pages read, each kept between syncs by
 * `report-cache.ts`. Same names and signatures as the originals, so a page
 * changes only where it imports them from; the number checks call the
 * originals and are unaffected.
 *
 * Not here: anything per person (the product tour, the session). `loadMetrics`
 * carries functions a cache cannot clone, so its rows are cached and the
 * functions rebuilt on each request.
 *
 * A report that reads calls is declared `'calls'` and recomputes on every call
 * delivery; every other report holds until a sync, a config change, a freeze
 * or a reconciliation. `apps/web/test/report-cache-scope.test.ts` fails if a
 * report reading calls is cached without it.
 */
export const callReport = cached('callReport', reporting.callReport, 'calls');
export const sourceFreshness = cached('sourceFreshness', dashboard.sourceFreshness, 'calls');
export const alowareConnectedThreshold = cached('alowareConnectedThreshold', dashboard.alowareConnectedThreshold, 'calls');
export const sourcesThrough = cached('sourcesThrough', coverage.sourcesThrough, 'calls');

/**
 * What every range's report reads that no range changes — the funnel, which
 * deals ever reached each stage, the last sync — the same for every range, so
 * read once per data version and handed to each `monthlyPerformance` (5 calls
 * on one Executive load) rather than read by each.
 */
const performanceContext = cached('performanceContext', reporting.performanceContext);
export async function monthlyPerformance(
  session: tenant.TenantSession,
  range: Parameters<typeof reporting.monthlyPerformance>[1],
  model?: Parameters<typeof reporting.monthlyPerformance>[2],
): Promise<reporting.MonthlyPerformance> {
  return cachedReport(session, 'monthlyPerformance', [range, model], async () =>
    reporting.monthlyPerformance(session, range, model, await performanceContext(session)),
  );
}

/** Several ranges on one transaction (Comparison's two periods), cached as one. */
export async function monthlyPerformances(
  session: tenant.TenantSession,
  ranges: readonly reporting.MonthlyPerformance['range'][],
  model?: Parameters<typeof reporting.monthlyPerformances>[2],
): Promise<reporting.MonthlyPerformance[]> {
  return cachedReport(session, 'monthlyPerformances', [ranges, model], async () => reporting.monthlyPerformances(session, ranges, model, await performanceContext(session)));
}

/**
 * The Comparison page's whole report, cached as every other page's reports
 * are: a reload or a source change that comes back to it costs one lookup.
 * It reads calls, so it is keyed on the newest delivery. Imported lazily,
 * since `lib/comparison` reads its inputs from this module.
 */
export async function comparisonReport(
  session: tenant.TenantSession,
  options: Parameters<typeof import('@/lib/comparison').comparisonReport>[1],
): Promise<import('@/lib/comparison').Comparison> {
  const { comparisonReport: report } = await import('@/lib/comparison');
  return cachedReport(session, 'comparisonReport', [options], () => report(session, options), 'calls');
}

/**
 * Reads calls only through `sourcesThrough` (the calls source's last day), so
 * it takes that result and is keyed on it: a call delivery that moves the day
 * recomputes the buckets, and the hundred that do not leave them be.
 */
export async function windowBuckets(
  session: tenant.TenantSession,
  ...args: Parameters<typeof dashboard.windowBuckets> extends [unknown, ...infer A] ? A : never
): Promise<dashboard.WindowBucket[]> {
  const [range, granularity, model] = args;
  const through = await sourcesThrough(session);
  return cachedReport(session, 'windowBuckets', [range, granularity, model, through], () =>
    dashboard.windowBuckets(session, range, granularity, model, through),
  );
}

export const submissionReport = cached('submissionReport', reporting.submissionReport);
export const dataQuality = cached('dataQuality', dashboard.dataQuality);
export const engagementRamp = cached('engagementRamp', dashboard.engagementRamp);
export const frozenBaseline = cached('frozenBaseline', dashboard.frozenBaseline);
export const connectionHealth = cached('connectionHealth', dashboard.connectionHealth);
export const pausedCampaigns = cached('pausedCampaigns', dashboard.pausedCampaigns);
export const ingestionStart = cached('ingestionStart', dashboard.ingestionStart);
export const breakdownAvailability = cached('breakdownAvailability', breakdown.breakdownAvailability);
export const breakdownRows = cached('breakdownRows', breakdown.breakdownRows);
export const declineReasonSummary = cached('declineReasonSummary', quality.declineReasonSummary);
export const reportingPlatforms = cached('reportingPlatforms', platforms.reportingPlatforms);
export const integratingPlatforms = cached('integratingPlatforms', platforms.integratingPlatforms);
export const seoView = cached('seoView', seo.seoView);
export const seoFigures = cached('seoFigures', seo.seoFigures);
/** Keyed on a digest of the images rather than the data version: they change on nobody's sync. */
export async function tenantLogo(session: tenant.TenantSession) {
  return cachedByDigest(session, 'tenantLogo', await tenant.tenantLogoDigest(session), () => tenant.tenantLogo(session));
}
export const platformView = cached('platformView', platform.platformView);
export const organicView = cached('organicView', organic.organicView);
export const reconciliationBySource = cached('reconciliationBySource', dashboard.reconciliationBySource);
export const tenantBusinessHours = cached('tenantBusinessHours', tenant.tenantBusinessHours);

const metricsInputs = cached('loadMetricsInputs', dashboard.loadMetricsInputs);
export async function loadMetrics(session: tenant.TenantSession): Promise<dashboard.Metrics> {
  return dashboard.buildMetrics(await metricsInputs(session));
}
