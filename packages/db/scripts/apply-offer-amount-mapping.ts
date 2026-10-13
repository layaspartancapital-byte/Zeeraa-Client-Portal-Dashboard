/**
 * Maps the deal's highest offer on the Salesforce connection, and nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-offer-amount-mapping.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-offer-amount-mapping.ts
 *
 * One write, from the seed: `fieldMapping.opportunity.maxOfferAmount`, so the
 * sync reads it into `opportunities.max_offer_amount`. Refuses until migration
 * 0045 has added that column, and if the stored value differs from the seed's
 * — once somebody maps it in production, the seed is the stale copy. The data
 * half is `packages/jobs/scripts/backfill-max-offer.ts`, run after this.
 * `--dry-run` writes, reads it back and rolls back: under FORCE a denied write
 * matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const seed = spartan.connections.find((c) => c.platform === 'salesforce')?.config as
  | { fieldMapping?: { opportunity?: { maxOfferAmount?: string } } }
  | undefined;
const field = seed?.fieldMapping?.opportunity?.maxOfferAmount;
if (!field) throw new Error('The seed maps no opportunity.maxOfferAmount.');

class Rollback extends Error {}

const { db, close } = getOwnerDb();
try {
  const report = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const [column] = await tx.execute<{ n: number }>(
      sql`select count(*)::int n from information_schema.columns
          where table_name = 'opportunities' and column_name = 'max_offer_amount'`,
    );
    if (Number(column?.n ?? 0) !== 1) throw new Error('Migration 0045 has not been applied.');

    const where = and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'salesforce'));
    const [conn] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(where);
    if (!conn) throw new Error('No Salesforce connection.');
    const config = structuredClone(conn.config ?? {}) as { fieldMapping?: { opportunity?: Record<string, unknown> } };
    if (!config.fieldMapping?.opportunity) throw new Error('The Salesforce connection has no opportunity mapping.');
    const before = config.fieldMapping.opportunity.maxOfferAmount;
    if (before !== undefined && before !== field) {
      throw new Error(`Refusing: opportunity.maxOfferAmount is already mapped to ${String(before)}, not ${field}.`);
    }
    config.fieldMapping.opportunity.maxOfferAmount = field;
    await tx.update(schema.connections).set({ config }).where(where);
    const [after] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(where);
    const stored = (after?.config as typeof config).fieldMapping?.opportunity?.maxOfferAmount;
    if (stored !== field) throw new Error('opportunity.maxOfferAmount did not read back — denied.');
    const line = `opportunity.maxOfferAmount: ${before === undefined ? 'added' : 'unchanged'} → ${field}`;
    if (DRY_RUN) {
      console.log(`Dry run against ${slug}, rolled back:\n  ${line}`);
      throw new Rollback();
    }
    return line;
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (report) console.log(`Applied for ${slug}:\n  ${report}`);
} finally {
  await close();
}
