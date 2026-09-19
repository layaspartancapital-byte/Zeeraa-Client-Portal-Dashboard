/**
 * Walks converted Leads to recover click IDs for the opportunities they became.
 *
 *   pnpm --filter @zeeraa/jobs backfill-click-ids <tenant-slug> [--since YYYY-MM-DD]
 *
 * Read-only against Salesforce, idempotent into Postgres. It exists as its own
 * entry point because the hourly incremental only ever walks its own watermark
 * window — so when a *new* click-ID field is added to the Lead mapping, nothing
 * goes back for the history that field has been carrying all along. That is not
 * a gap in the incremental; it is what a full pass is for.
 */
import { eq } from 'drizzle-orm';
import { getOwnerDb, schema, withMaintenance } from '@zeeraa/db';
import { resolveSalesforceContext } from '../src/salesforce/context';
import { backfillClickIdsFromConvertedLeads } from '../src/salesforce/backfill';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/backfill-click-ids.ts <tenant-slug> [--since YYYY-MM-DD]');

const sinceIndex = args.indexOf('--since');
const since = sinceIndex === -1 ? undefined : new Date(`${args[sinceIndex + 1]}T00:00:00Z`);

const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [connection] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(eq(schema.connections.platform, 'salesforce'));
    if (!connection) throw new Error(`${tenant.name} has no salesforce connection.`);

    console.log(`${tenant.name} — recovering click IDs from converted leads`);
    return { tenantId: tenant.id, connectionId: connection.id };
  });

  const context = await resolveSalesforceContext(tenantId, connectionId);
  const fields = Object.entries(context.mapping.lead.clickIds);
  console.log(`  mapped click-ID fields: ${fields.map(([p, f]) => `${p}=${f}`).join(', ')}`);
  if (since) console.log(`  since: ${since.toISOString().slice(0, 10)}`);

  const result = await backfillClickIdsFromConvertedLeads({
    tenantId,
    client: context.client,
    mapping: context.mapping,
    since,
  });

  console.log(`\n  leads examined:        ${result.leadsExamined}`);
  console.log(`  click ids recovered:   ${result.clickIdsRecovered}`);
  console.log(`  leads with no click:   ${result.leadsWithoutClickId}`);
  for (const [platform, n] of Object.entries(result.platforms)) {
    console.log(`    ${platform.padEnd(16)} ${n}`);
  }
  console.log(`\n  status: ${result.status}${result.note ? ` — ${result.note}` : ''}`);
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
