/**
 * Fills `leads.revenue_band` (migration 0034) for leads ingested before the
 * sync stored it, by reading their revenue answers from Salesforce and placing
 * them exactly as the sync does (`readRevenueBand`). Writes that one column
 * and nothing else — no re-pull of stages, attribution or anything a full
 * sync would touch.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/backfill-revenue-band.ts <slug> --dry-run
 *
 * Read-only against Salesforce. `--dry-run` writes, counts what landed and
 * rolls back: under FORCE a denied write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { readRevenueBand, type SalesforceRecord } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--')) throw new Error('Usage: backfill-revenue-band.ts <slug> [--dry-run]');

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
if (!ctx.mapping.lead.revenueBandEdges?.length) {
  throw new Error('The connection has no revenueBandEdges; run apply-client-fixes.ts first.');
}
const fields = [...new Set((ctx.mapping.lead.revenueBands ?? []).map((c) => c.field))];

const earliest = await withJobTenant(tenantId, async (tx) => {
  const [row] = await tx
    .select({ at: sql<Date>`min(${schema.leads.createdAt})` })
    .from(schema.leads)
    .where(eq(schema.leads.tenantId, tenantId));
  return row?.at ? new Date(row.at) : null;
});
if (!earliest) throw new Error('No leads stored.');

const records = await ctx.client.query<SalesforceRecord>(
  `SELECT Id, ${fields.join(', ')} FROM Lead WHERE CreatedDate >= ${earliest.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
  true,
);
const bands = records.map((r) => ({ id: String(r.Id), band: readRevenueBand(r, ctx.mapping) }));
const tally = new Map<string, number>();
for (const { band } of bands) tally.set(band ?? '(no answer)', (tally.get(band ?? '(no answer)') ?? 0) + 1);
console.log(`${records.length} Salesforce leads since ${earliest.toISOString().slice(0, 10)}:`);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);

const written = await withJobTenant(tenantId, async (tx) => {
  let n = 0;
  for (let i = 0; i < bands.length; i += 1000) {
    const chunk = bands.slice(i, i + 1000);
    const updated = await tx.execute<{ id: string }>(sql`
      update leads set revenue_band = v.band
      from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id text, band text)
      where leads.tenant_id = ${tenantId} and leads.external_id = v.id
        and leads.revenue_band is distinct from v.band
      returning leads.id`);
    n += updated.length;
  }
  const [check] = await tx.execute<{ n: number }>(
    sql`select count(*)::int n from leads where tenant_id = ${tenantId} and revenue_band is not null`,
  );
  console.log(`Rows changed: ${n}; leads with a band value now: ${check!.n}`);
  if (DRY_RUN) throw new Rollback();
  return n;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(written === null ? 'Dry run: rolled back. Nothing changed.' : `Backfilled ${written} leads.`);
process.exit(0);
