/**
 * Fills `opportunities.max_offer_amount` (migration 0045) for deals stored
 * before the sync read it, and corrects any that differ from Salesforce.
 * Writes that one column and nothing else.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/backfill-max-offer.ts <slug> --dry-run
 *
 * Reads the field the stored mapping names (`opportunity.maxOfferAmount`;
 * `apply-offer-amount-mapping.ts` stores it), so it cannot disagree with the
 * sync. Read-only against Salesforce, by id, two hundred to a query.
 * `--dry-run` writes, counts what landed and rolls back: under FORCE a denied
 * write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import type { SalesforceRecord } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--')) throw new Error('Usage: backfill-max-offer.ts <slug> [--dry-run]');

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
const field = ctx.mapping.opportunity.maxOfferAmount;
if (!field) throw new Error('The connection maps no opportunity.maxOfferAmount; run apply-offer-amount-mapping.ts first.');

const stored = await withJobTenant(tenantId, (tx) =>
  tx
    .select({ id: schema.opportunities.externalId })
    .from(schema.opportunities)
    .where(eq(schema.opportunities.tenantId, tenantId)),
);
const values: { id: string; amount: string | null }[] = [];
for (let i = 0; i < stored.length; i += 200) {
  const ids = stored.slice(i, i + 200).map((m) => `'${m.id.replace(/[^A-Za-z0-9]/g, '')}'`);
  const records = await ctx.client.query<SalesforceRecord>(`SELECT Id, ${field} FROM Opportunity WHERE Id IN (${ids.join(',')})`, true);
  for (const r of records) {
    const v = r[field];
    values.push({ id: String(r.Id), amount: typeof v === 'number' ? v.toFixed(2) : null });
  }
}
console.log(`${stored.length} stored opportunities; Salesforce returned ${values.length}, ${values.filter((v) => v.amount !== null).length} with an offer amount.`);

const written = await withJobTenant(tenantId, async (tx) => {
  let n = 0;
  for (let i = 0; i < values.length; i += 1000) {
    const updated = await tx.execute<{ id: string }>(sql`
      update opportunities set max_offer_amount = v.amount::numeric
      from jsonb_to_recordset(${JSON.stringify(values.slice(i, i + 1000))}::jsonb) as v(id text, amount text)
      where opportunities.tenant_id = ${tenantId} and opportunities.external_id = v.id
        and opportunities.max_offer_amount is distinct from v.amount::numeric
      returning opportunities.id`);
    n += updated.length;
  }
  const [check] = await tx.execute<{ n: number; total: string }>(
    sql`select count(max_offer_amount)::int n, coalesce(sum(max_offer_amount), 0)::text total
        from opportunities where tenant_id = ${tenantId}`,
  );
  console.log(`Rows changed: ${n}; opportunities with an offer amount: ${check!.n}, totalling $${check!.total}`);
  if (DRY_RUN) throw new Rollback();
  return n;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(written === null ? 'Dry run: rolled back. Nothing changed.' : `Backfilled ${written} opportunities.`);
process.exit(0);
