/**
 * Fills `crm_contacts` (migration 0046) for the leads and deals stored before
 * the sync read contact fields. Writes that table and nothing else.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/backfill-contacts.ts <slug> --dry-run
 *
 * Reads the fields the stored mapping names (`lead.contact`,
 * `opportunity.contact`; `apply-contact-mapping.ts` stores them), so it cannot
 * disagree with the sync, by id, two hundred to a query, read-only against
 * Salesforce. A lead's phone is the one already stored on it. Nothing but
 * name, email, phone, company and owner is read. `--dry-run` writes, counts
 * what landed and rolls back: under FORCE a denied write matches nothing and
 * exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import type { ContactMapping, SalesforceRecord } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';
import { upsertContacts } from '../src/salesforce/writer';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
if (!slug || slug.startsWith('--')) throw new Error('Usage: backfill-contacts.ts <slug> [--dry-run]');

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
const leadMap = ctx.mapping.lead.contact;
const oppMap = ctx.mapping.opportunity.contact;
if (!leadMap || !oppMap) throw new Error('The connection maps no contact fields; run apply-contact-mapping.ts first.');

/** `Owner.Name` off a REST record, which nests relationships. */
const read = (r: SalesforceRecord, field?: string): string | null => {
  if (!field) return null;
  const v = field.split('.').reduce<unknown>((at, k) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[k] : null), r);
  const text = v == null ? '' : String(v).trim();
  return text === '' ? null : text;
};
const fieldsOf = (m: ContactMapping) => [...new Set(Object.values(m).filter((f): f is string => Boolean(f)))];

async function fetchContacts(object: 'Lead' | 'Opportunity', ids: string[], mapping: ContactMapping) {
  const out = new Map<string, { name: string | null; email: string | null; company: string | null; owner: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200).map((id) => `'${id.replace(/[^A-Za-z0-9]/g, '')}'`);
    const records = await ctx.client.query<SalesforceRecord>(
      `SELECT Id, ${fieldsOf(mapping).join(', ')} FROM ${object} WHERE Id IN (${batch.join(',')})`,
      true,
    );
    for (const r of records) {
      out.set(String(r.Id), {
        name: read(r, mapping.name),
        email: read(r, mapping.email),
        company: read(r, mapping.company),
        owner: read(r, mapping.owner),
      });
    }
  }
  return out;
}

const [leads, opportunities] = await withJobTenant(tenantId, (tx) =>
  Promise.all([
    tx.select({ id: schema.leads.externalId, phone: schema.leads.phone }).from(schema.leads).where(eq(schema.leads.tenantId, tenantId)),
    tx.select({ id: schema.opportunities.externalId }).from(schema.opportunities).where(eq(schema.opportunities.tenantId, tenantId)),
  ]),
);
const leadContacts = await fetchContacts('Lead', leads.map((l) => l.id), leadMap);
const oppContacts = await fetchContacts('Opportunity', opportunities.map((o) => o.id), oppMap);
console.log(
  `${leads.length} leads, Salesforce returned ${leadContacts.size}; ${opportunities.length} opportunities, returned ${oppContacts.size}.`,
);

const written = await withJobTenant(tenantId, async (tx) => {
  const n =
    (await upsertContacts(
      tx,
      tenantId,
      leads.map((l) => ({ object: 'lead' as const, externalId: l.id, contact: leadContacts.get(l.id), phone: l.phone })),
      null,
    )) +
    (await upsertContacts(
      tx,
      tenantId,
      opportunities.map((o) => ({ object: 'opportunity' as const, externalId: o.id, contact: oppContacts.get(o.id) })),
      null,
    ));
  const all = await tx.execute<{ object: string; n: number; named: number; emailed: number; owned: number }>(sql`
    select object, count(*)::int n, count(name)::int named, count(email)::int emailed, count(owner_name)::int owned
    from crm_contacts where tenant_id = ${tenantId} group by object order by object`);
  for (const r of all) console.log(`  ${r.object}: ${r.n} rows, ${r.named} named, ${r.emailed} with email, ${r.owned} with an owner`);
  if (DRY_RUN) throw new Rollback();
  return n;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(written === null ? 'Dry run: rolled back. Nothing changed.' : `Wrote ${written} contact rows.`);
process.exit(0);
