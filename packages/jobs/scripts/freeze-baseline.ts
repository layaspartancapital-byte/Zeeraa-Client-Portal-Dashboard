/**
 * Freezes audited baseline months (migration 0032).
 *
 *   pnpm --filter @zeeraa/jobs freeze-baseline <tenant-slug> <YYYY-MM>... --by "<name>" --reason "<why>" [--dry-run]
 *
 * Writes each month's six ramp figures once, exactly as the ramp computes them,
 * with who and why. The table refuses edits for every role; a frozen month is
 * corrected by inserting the next version, never by running this again.
 * `--dry-run` computes and prints without writing.
 *
 * `--channel-figures` freezes the other key figures instead — every funnel
 * stage per channel, and each paid channel's spend, volume, CPA and cost per
 * funded deal (`freezeChannelFigures`) — which the pre-deploy number check
 * compares against.
 *
 * `--correct <metric,...>` corrects one frozen ramp month instead: the named
 * metrics recomputed now and inserted as the next version with the reason.
 */
import { eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance } from '@zeeraa/db';
import { correctBaselineMonth, freezeBaselineMonths, freezeChannelFigures } from '../src/freeze';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const slug = args[0];
const months = args.slice(1).filter((a, i, all) => /^\d{4}-\d{2}$/.test(a) && !['--by', '--reason', '--correct'].includes(all[i - 1] ?? ''));
const by = flag('--by');
const reason = flag('--reason');
const dryRun = args.includes('--dry-run');
const channel = args.includes('--channel-figures');
if (!slug || months.length === 0 || !by || !reason) {
  throw new Error('Usage: freeze-baseline <slug> <YYYY-MM>... --by "<name>" --reason "<why>" [--dry-run] [--channel-figures]');
}

const [tenant] = await withMaintenance(getMaintenanceDb(), (tx) =>
  tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug)),
);
if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

const correct = flag('--correct');
if (correct) {
  if (months.length !== 1) throw new Error('--correct takes exactly one month.');
  const metrics = correct.split(',') as Parameters<typeof correctBaselineMonth>[0]['metrics'];
  for (const r of await correctBaselineMonth({ tenantId: tenant.id, month: months[0]!, metrics, by, reason, dryRun })) {
    console.log(`${months[0]}  ${r.metric} v${r.version}${dryRun ? ' (dry run)' : ''}: ${r.before ?? 'blank'} → ${r.after ?? 'blank'}`);
  }
  process.exit(0);
}
const freeze = channel ? freezeChannelFigures : freezeBaselineMonths;
for (const o of await freeze({ tenantId: tenant.id, months, by, reason, dryRun })) {
  console.log(`${o.month}  ${o.status.padEnd(15)} ${o.detail}`);
}
process.exit(0);
