/**
 * Runs the daily reconciliation by hand and prints every check.
 *
 *   pnpm --filter @zeeraa/jobs reconcile <tenant-slug>
 *
 * Read-only against every source; writes the check rows the Connections screen
 * reads, as the daily job does. `DATABASE_URL_MAINT`, `DATABASE_URL_JOBS`,
 * `ENCRYPTION_KEY`.
 */
import { eq } from 'drizzle-orm';
import { getMaintenanceDb, schema, withMaintenance } from '@zeeraa/db';
import { runReconciliation } from '../src/reconcile';

const slug = process.argv[2];
if (!slug) throw new Error('Usage: reconcile <tenant-slug>');
const [tenant] = await withMaintenance(getMaintenanceDb(), (tx) =>
  tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug)),
);
if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

const [result] = await runReconciliation({ tenantId: tenant.id });
for (const c of result?.checks ?? []) {
  const nums = c.ours === null ? '' : `ours ${c.ours} · theirs ${c.theirs}`;
  console.log(`${c.status.padEnd(9)} ${c.source.padEnd(15)} ${c.metric.padEnd(20)} ${c.window.start}..${c.window.end}  ${nums}${c.detail ? `  — ${c.detail}` : ''}`);
}
process.exit(0);
