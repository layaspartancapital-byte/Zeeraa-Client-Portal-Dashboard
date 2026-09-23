/**
 * Freezes audited baseline months (migration 0032).
 *
 *   pnpm --filter @zeeraa/jobs freeze-baseline <tenant-slug> <YYYY-MM>... --by "<name>" --reason "<why>" [--dry-run]
 *
 * Writes each month's six ramp figures once, exactly as the ramp computes them,
 * with who and why. The table refuses edits for every role; a frozen month is
 * corrected by inserting the next version, never by running this again.
 * `--dry-run` computes and prints without writing.
 */
import { eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance } from '@zeeraa/db';
import { freezeBaselineMonths } from '../src/freeze';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const slug = args[0];
const months = args.slice(1).filter((a, i, all) => /^\d{4}-\d{2}$/.test(a) && !['--by', '--reason'].includes(all[i - 1] ?? ''));
const by = flag('--by');
const reason = flag('--reason');
const dryRun = args.includes('--dry-run');
if (!slug || months.length === 0 || !by || !reason) {
  throw new Error('Usage: freeze-baseline <slug> <YYYY-MM>... --by "<name>" --reason "<why>" [--dry-run]');
}

const [tenant] = await withMaintenance(getMaintenanceDb(), (tx) =>
  tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug)),
);
if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

for (const o of await freezeBaselineMonths({ tenantId: tenant.id, months, by, reason, dryRun })) {
  console.log(`${o.month}  ${o.status.padEnd(15)} ${o.detail}`);
}
process.exit(0);
