/**
 * The Semrush sync for one tenant, run by hand.
 *
 *   pnpm --filter @zeeraa/jobs sync-semrush <tenant-slug> [--plan] [--force r1,r2] [--only r1,r2]
 *
 * `--plan` reads nothing from Semrush and spends nothing: it prints which
 * reports are due, the most each could cost, and the year's ceiling. Run it
 * before a first sync, because the first read of each history report asks for
 * two years.
 *
 * The nightly re-pull runs the same function, so a report read here is not
 * read again tonight — `seo_report_reads` is what both consult.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  maxUnitsPerRead,
  plannedAnnualUnits,
  semrushReportDue,
  SEMRUSH_HISTORY_MONTHS,
  SEMRUSH_REPORTS,
  tenantDay,
  type SemrushReportKey,
} from '@zeeraa/core';
import { getOwnerDb, schema, withMaintenance } from '@zeeraa/db';
import { resolveSemrushContext } from '../src/semrush/context';
import { runSemrushSync } from '../src/semrush/sync';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/sync-semrush.ts <tenant-slug> [--plan] [--force a,b] [--only a,b]');
const list = (flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : (args[i + 1]!.split(',') as SemrushReportKey[]);
};
const plan = args.includes('--plan');
const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId, timezone, lastRead } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, timezone: schema.tenants.timezone })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const [connection] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'semrush')));
    if (!connection) throw new Error('No Semrush connection row. Run configure-semrush first.');
    const reads = await tx
      .select({
        report: schema.seoReportReads.report,
        last: sql<string>`to_char(max(${schema.seoReportReads.readOn}), 'YYYY-MM-DD')`,
      })
      .from(schema.seoReportReads)
      .where(eq(schema.seoReportReads.tenantId, tenant.id))
      .groupBy(schema.seoReportReads.report);
    return {
      tenantId: tenant.id,
      connectionId: connection.id,
      timezone: tenant.timezone,
      lastRead: new Map(reads.map((r) => [r.report, r.last])),
    };
  });

  const context = await resolveSemrushContext(tenantId, connectionId);
  const tracking = Boolean(context.config.trackingCampaignId);
  if (plan) {
    const today = tenantDay(new Date(), timezone);
    let total = 0;
    for (const r of SEMRUSH_REPORTS) {
      const due = semrushReportDue(r.cadence, lastRead.get(r.key) ?? null, today);
      const history = (r.key === 'domain_history' || r.key === 'backlinks_history') && !lastRead.has(r.key);
      const lines = history
        ? SEMRUSH_HISTORY_MONTHS
        : r.key === 'tracking_positions'
          ? (context.config.trackedKeywords ?? r.lines)
          : r.lines;
      const max = maxUnitsPerRead(r, lines);
      const runs = due && (tracking || !r.tracking);
      if (runs) total += max;
      console.log(
        `  ${r.key.padEnd(24)} ${r.cadence.padEnd(8)} last ${lastRead.get(r.key) ?? 'never'.padEnd(10)}  ` +
          `${runs ? `due, up to ${max.toLocaleString('en-US')} units` : r.tracking && !tracking ? 'no tracking campaign' : 'not due'}`,
      );
    }
    console.log(`\n  This run: up to ${total.toLocaleString('en-US')} units.`);
    console.log(
      `  Year ceiling: ${plannedAnnualUnits({ tracking, trackedKeywords: context.config.trackedKeywords }).toLocaleString('en-US')} units; ` +
        `allowance ${(context.config.annualUnitBudget ?? 400_000).toLocaleString('en-US')}.`,
    );
    console.log(`  Balance: ${(await context.client.balance())?.toLocaleString('en-US') ?? 'unknown'} units.`);
  } else {
    const result = await runSemrushSync(context, { trigger: 'manual', force: list('--force'), only: list('--only') });
    for (const o of result.outcomes) {
      if (o.status === 'not_due') continue;
      console.log(`  ${o.report.padEnd(24)} ${o.status.padEnd(8)} ${String(o.rows).padStart(5)} rows  ${String(o.units).padStart(6)} units${o.detail ? `  ${o.detail}` : ''}`);
    }
    console.log(`\n  ${result.status}: ${result.unitsSpent.toLocaleString('en-US')} units spent.`);
  }
} finally {
  // A pooled socket outlives both closes (sync-organic has the same), so the
  // wait is bounded and this one-shot script exits rather than hanging.
  const { closeConnections } = await import('@zeeraa/db');
  const settle = new Promise((resolve) => setTimeout(resolve, 3000));
  await Promise.race([Promise.all([close(), closeConnections()]), settle]);
  process.exit(process.exitCode ?? 0);
}
