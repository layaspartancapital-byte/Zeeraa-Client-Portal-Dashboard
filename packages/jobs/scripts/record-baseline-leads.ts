/**
 * Records which leads each frozen month's lead counts are made of (migration
 * 0047), for months frozen before the freeze recorded them itself.
 *
 *   pnpm --filter @zeeraa/jobs record-baseline-leads <tenant-slug> <YYYY-MM>... --by "<name>" --reason "<why>" [--dry-run]
 *
 * Only valid while every frozen lead count of the month equals the count now
 * — the deploy's baseline check passing — since the recording is of the leads
 * as they stand: `recordBaselineLeads` refuses otherwise. Refuses a month
 * that already has a recording; the freeze and its corrections write those.
 *
 * `--dry-run` writes, reads the recording back and rolls back: under FORCE a
 * denied write matches nothing and exits 0, so the read-back is what says it
 * landed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { isMonthKey } from '@zeeraa/core';
import { recordBaselineLeads } from '../src/baseline-leads';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const slug = args[0];
const months = args.slice(1).filter((a) => isMonthKey(a));
const by = flag('--by');
const reason = flag('--reason');
const DRY_RUN = args.includes('--dry-run');
if (!slug || months.length === 0 || !by || !reason) {
  throw new Error('Usage: record-baseline-leads <slug> <YYYY-MM>... --by "<name>" --reason "<why>" [--dry-run]');
}

class Rollback extends Error {}

const tenantId = await withMaintenance(getMaintenanceDb(), async (tx) => {
  const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!t) throw new Error(`No tenant with slug "${slug}".`);
  return t.id;
});

const now = new Date();
for (const month of months) {
  const result = await withJobTenant(tenantId, async (tx) => {
    const where = and(eq(schema.baselineLeads.tenantId, tenantId), eq(schema.baselineLeads.month, `${month}-01`));
    const [prior] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.baselineLeads).where(where);
    if (Number(prior?.n ?? 0) > 0) throw new Error(`${month} already has a lead recording.`);
    const written = await recordBaselineLeads(tx, tenantId, month, { by, reason, now });
    const [back] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.baselineLeads).where(where);
    if (Number(back?.n ?? 0) !== written || written === 0) {
      throw new Error(`Refusing to commit ${month}: wrote ${written}, read back ${back?.n ?? 0} — a denied write?`);
    }
    if (DRY_RUN) {
      console.log(`${month}  ${written} leads recorded and read back (dry run)`);
      throw new Rollback();
    }
    return written;
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (result !== null) console.log(`${month}  ${result} leads recorded`);
}
process.exit(0);
