/**
 * Marks every stored lead that now falls under an exclusion rule in
 * Salesforce, and nothing else (`markLeadsNowExcluded`, every lead rather than
 * those modified since the last read).
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/reexclude-leads.ts <slug> [--dry-run]
 *
 * Read-only against Salesforce. Prints the leads newly excluded by rule and by
 * the month they were counted in — a frozen month among them needs a
 * correction frozen. `--dry-run` writes, counts and rolls back: under FORCE a
 * denied write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { NO_LEAD_EXCLUSION } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';
import { markLeadsNowExcluded } from '../src/salesforce/reexclude';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--')) throw new Error('Usage: reexclude-leads.ts <slug> [--dry-run]');

class Rollback extends Error {}

const { tenantId, connectionId } = await withMaintenance(getMaintenanceDb(), async (tx) => {
  const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!t) throw new Error(`No tenant with slug "${slug}".`);
  const [c] = await tx
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(and(eq(schema.connections.tenantId, t.id), eq(schema.connections.platform, 'salesforce')));
  if (!c) throw new Error('No Salesforce connection.');
  return { tenantId: t.id, connectionId: c.id };
});
const ctx = await resolveSalesforceContext(tenantId, connectionId);
const stamp = new Date();

const marked = await withJobTenant(tenantId, async (tx) => {
  const counts = await markLeadsNowExcluded(ctx.client, tx, tenantId, ctx.leadExclusion ?? NO_LEAD_EXCLUSION, null);
  const byMonth = await tx.execute<{ month: string; reason: string; n: number; ids: string }>(sql`
    select to_char(created_on, 'YYYY-MM') as month, excluded_reason as reason, count(*)::int as n,
           string_agg(external_id, ', ' order by external_id) as ids
    from ${schema.leads}
    where tenant_id = ${tenantId} and updated_at >= ${stamp.toISOString()} and excluded_reason is not null
    group by 1, 2 order by 1, 2`);
  console.log('Newly excluded, by rule:', JSON.stringify(counts));
  for (const r of byMonth) console.log(`  ${r.month}  ${r.reason}: ${r.n}  (${r.ids.slice(0, 200)})`);
  if (DRY_RUN) throw new Rollback();
  return counts;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(marked === null ? 'Dry run: rolled back. Nothing changed.' : 'Done.');
process.exit(0);
