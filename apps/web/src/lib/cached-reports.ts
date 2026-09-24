import 'server-only';
import { cached } from '@/lib/report-cache';
import * as reporting from '@/lib/reporting';
import * as dashboard from '@/lib/dashboard';
import * as coverage from '@/lib/coverage';
import * as breakdown from '@/lib/breakdown';
import * as quality from '@/lib/quality-measures';
import * as platforms from '@/lib/platforms';
import * as tenant from '@/lib/tenant';

/**
 * The report functions the dashboard pages read, each kept between syncs by
 * `report-cache.ts`. Same names and signatures as the originals, so a page
 * changes only where it imports them from; the number checks call the
 * originals and are unaffected.
 *
 * Not here: anything per person (the product tour, the session). `loadMetrics`
 * carries functions a cache cannot clone, so its rows are cached and the
 * functions rebuilt on each request.
 */
export const monthlyPerformance = cached('monthlyPerformance', reporting.monthlyPerformance);
export const callReport = cached('callReport', reporting.callReport);
export const submissionReport = cached('submissionReport', reporting.submissionReport);
export const windowBuckets = cached('windowBuckets', dashboard.windowBuckets);
export const dataQuality = cached('dataQuality', dashboard.dataQuality);
export const engagementRamp = cached('engagementRamp', dashboard.engagementRamp);
export const frozenBaseline = cached('frozenBaseline', dashboard.frozenBaseline);
export const connectionHealth = cached('connectionHealth', dashboard.connectionHealth);
export const pausedCampaigns = cached('pausedCampaigns', dashboard.pausedCampaigns);
export const sourceFreshness = cached('sourceFreshness', dashboard.sourceFreshness);
export const alowareConnectedThreshold = cached('alowareConnectedThreshold', dashboard.alowareConnectedThreshold);
export const ingestionStart = cached('ingestionStart', dashboard.ingestionStart);
export const sourcesThrough = cached('sourcesThrough', coverage.sourcesThrough);
export const breakdownAvailability = cached('breakdownAvailability', breakdown.breakdownAvailability);
export const breakdownRows = cached('breakdownRows', breakdown.breakdownRows);
export const declineReasonSummary = cached('declineReasonSummary', quality.declineReasonSummary);
export const reportingPlatforms = cached('reportingPlatforms', platforms.reportingPlatforms);
export const tenantLogo = cached('tenantLogo', tenant.tenantLogo);
export const tenantBusinessHours = cached('tenantBusinessHours', tenant.tenantBusinessHours);

const metricsInputs = cached('loadMetricsInputs', dashboard.loadMetricsInputs);
export async function loadMetrics(session: tenant.TenantSession): Promise<dashboard.Metrics> {
  return dashboard.buildMetrics(await metricsInputs(session));
}
