/**
 * Maps the contact fields on the Salesforce connection, and nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-contact-mapping.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-contact-mapping.ts
 *
 * Two writes, from the seed: `fieldMapping.lead.contact` and
 * `fieldMapping.opportunity.contact` — name, email, company and owner, which
 * the sync writes to `crm_contacts` (only an admin reads it). Refuses until
 * migration 0046 has created that table, and if a stored value differs from
 * the seed's. The data half is `packages/jobs/scripts/backfill-contacts.ts`,
 * run after this. `--dry-run` writes, reads it back and rolls back: under
 * FORCE a denied write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
type Contact = Record<string, string>;
type Mapping = { fieldMapping?: { lead?: { contact?: Contact }; opportunity?: { contact?: Contact } } };
const seed = spartan.connections.find((c) => c.platform === 'salesforce')?.config as Mapping | undefined;
const wanted = { lead: seed?.fieldMapping?.lead?.contact, opportunity: seed?.fieldMapping?.opportunity?.contact };
if (!wanted.lead || !wanted.opportunity) throw new Error('The seed maps no contact fields.');

class Rollback extends Error {}

const { db, close } = getOwnerDb();
try {
  const report = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const [table] = await tx.execute<{ n: number }>(
      sql`select count(*)::int n from information_schema.tables where table_name = 'crm_contacts'`,
    );
    if (Number(table?.n ?? 0) !== 1) throw new Error('Migration 0046 has not been applied.');

    const where = and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'salesforce'));
    const [conn] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(where);
    if (!conn) throw new Error('No Salesforce connection.');
    const config = structuredClone(conn.config ?? {}) as Mapping;
    const lines: string[] = [];
    for (const object of ['lead', 'opportunity'] as const) {
      const section = config.fieldMapping?.[object];
      if (!section) throw new Error(`The Salesforce connection has no ${object} mapping.`);
      const before = section.contact;
      if (before !== undefined && JSON.stringify(before) !== JSON.stringify(wanted[object])) {
        throw new Error(`Refusing: ${object}.contact is already mapped to ${JSON.stringify(before)}.`);
      }
      section.contact = wanted[object]!;
      lines.push(`${object}.contact: ${before === undefined ? 'added' : 'unchanged'} → ${JSON.stringify(wanted[object])}`);
    }
    await tx.update(schema.connections).set({ config }).where(where);
    const [after] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(where);
    const stored = after?.config as Mapping;
    if (JSON.stringify(stored.fieldMapping?.lead?.contact) !== JSON.stringify(wanted.lead)) {
      throw new Error('lead.contact did not read back — denied.');
    }
    if (DRY_RUN) {
      console.log(`Dry run against ${slug}, rolled back:\n  ${lines.join('\n  ')}`);
      throw new Rollback();
    }
    return lines.join('\n  ');
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (report) console.log(`Applied for ${slug}:\n  ${report}`);
} finally {
  await close();
}
