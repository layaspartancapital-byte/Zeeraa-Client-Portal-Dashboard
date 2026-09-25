/**
 * Fills `opportunities.name` (migration 0041) for deals stored before the sync
 * read `Opportunity.Name`. Writes that one column and nothing else.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/backfill-opportunity-names.ts <slug> --dry-run
 *
 * Read-only against Salesforce, by id, two hundred to a query. `--dry-run`
 * writes, counts what landed and rolls back: under FORCE a denied write
 * matches nothing and exits 0.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import type { SalesforceRecord } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--')) throw new Error('Usage: backfill-opportunity-names.ts <slug> [--dry-run]');

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

const missing = await withJobTenant(tenantId, (tx) =>
  tx
    .select({ id: schema.opportunities.externalId })
    .from(schema.opportunities)
    .where(and(eq(schema.opportunities.tenantId, tenantId), isNull(schema.opportunities.name))),
);
console.log(`${missing.length} stored opportunities have no name.`);
if (missing.length === 0) process.exit(0);

const ctx = await resolveSalesforceContext(tenantId, connectionId);
const named: { id: string; name: string }[] = [];
for (let i = 0; i < missing.length; i += 200) {
  const ids = missing.slice(i, i + 200).map((m) => `'${m.id.replace(/[^A-Za-z0-9]/g, '')}'`);
  const records = await ctx.client.query<SalesforceRecord>(
    `SELECT Id, Name FROM Opportunity WHERE Id IN (${ids.join(',')})`,
    true,
  );
  for (const r of records) if (typeof r.Name === 'string' && r.Name) named.push({ id: String(r.Id), name: r.Name });
}
console.log(`Salesforce returned a name for ${named.length}.`);

const written = await withJobTenant(tenantId, async (tx) => {
  let n = 0;
  for (let i = 0; i < named.length; i += 1000) {
    const updated = await tx.execute<{ id: string }>(sql`
      update opportunities set name = v.name
      from jsonb_to_recordset(${JSON.stringify(named.slice(i, i + 1000))}::jsonb) as v(id text, name text)
      where opportunities.tenant_id = ${tenantId} and opportunities.external_id = v.id
        and opportunities.name is null
      returning opportunities.id`);
    n += updated.length;
  }
  const [check] = await tx.execute<{ n: number }>(
    sql`select count(*)::int n from opportunities where tenant_id = ${tenantId} and name is null`,
  );
  console.log(`Rows changed: ${n}; still without a name: ${check!.n}`);
  if (DRY_RUN) throw new Rollback();
  return n;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(written === null ? 'Dry run: rolled back. Nothing changed.' : `Backfilled ${written} opportunities.`);
process.exit(0);
