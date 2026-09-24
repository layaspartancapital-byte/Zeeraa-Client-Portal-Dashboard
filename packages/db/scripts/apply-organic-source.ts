/**
 * Loads the configuration organic search needs, and nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-organic-source.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-organic-source.ts
 *
 * Two writes, both from the seed:
 *
 *   1. `fieldMapping.lead.referrer` on the Salesforce connection, so the sync
 *      reads the referring page.
 *   2. The `organic_search_evidence` config row, the test a lead must pass to
 *      be credited to Organic/SEO.
 *
 * Refuses until migration 0035 has added `leads.referrer_url`. The data half —
 * reading the referrer for existing leads and re-resolving their channel — is
 * `packages/jobs/scripts/backfill-lead-channel.ts`, run after this.
 *
 * `--dry-run` writes inside a transaction, reads both back and rolls back:
 * under FORCE a denied write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const KEY = 'organic_search_evidence';

const salesforceSeed = spartan.connections.find((c) => c.platform === 'salesforce');
const referrer = (salesforceSeed?.config as { fieldMapping?: { lead?: { referrer?: string } } } | undefined)?.fieldMapping
  ?.lead?.referrer;
const rule = spartan.config.find((c) => c.key === KEY);
if (!referrer || !rule) throw new Error(`The seed carries no lead referrer mapping or ${KEY} row.`);

class Rollback extends Error {}

const { db, close } = getOwnerDb();
try {
  const report = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [column] = await tx.execute<{ n: number }>(
      sql`select count(*)::int n from information_schema.columns where table_name = 'leads' and column_name = 'referrer_url'`,
    );
    if (!column || Number(column.n) === 0) throw new Error('Migration 0035 has not been applied: leads.referrer_url is missing.');

    const connWhere = and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'salesforce'));
    const [conn] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(connWhere);
    if (!conn) throw new Error('No Salesforce connection.');
    const config = structuredClone(conn.config ?? {}) as { fieldMapping?: { lead?: Record<string, unknown> } };
    if (!config.fieldMapping?.lead) throw new Error('The Salesforce connection has no lead mapping.');
    const before = config.fieldMapping.lead.referrer ?? '(none)';
    config.fieldMapping.lead.referrer = referrer;
    await tx.update(schema.connections).set({ config }).where(connWhere);
    const [connAfter] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(connWhere);
    if ((connAfter?.config as typeof config).fieldMapping?.lead?.referrer !== referrer) {
      throw new Error('The referrer mapping did not read back — denied.');
    }

    await tx
      .insert(schema.tenantConfig)
      .values({ tenantId: tenant.id, key: KEY, value: rule.value, description: rule.description ?? null })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: rule.value, description: rule.description ?? null, updatedAt: new Date() },
      });
    const [row] = await tx
      .select({ value: schema.tenantConfig.value })
      .from(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, KEY)));
    if (JSON.stringify(row?.value) !== JSON.stringify(rule.value)) throw new Error(`${KEY} did not read back — denied.`);

    const result = `referrer mapping: ${String(before)} → ${referrer}\n  ${KEY}: ${JSON.stringify(rule.value)}`;
    if (DRY_RUN) {
      console.log(`Dry run against ${slug}, rolled back:\n  ${result}`);
      throw new Rollback();
    }
    return result;
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (report) console.log(`Applied for ${slug}:\n  ${report}`);
} finally {
  await close();
}
