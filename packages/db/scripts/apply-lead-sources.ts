/**
 * Loads the configuration lead sources need, and nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-lead-sources.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/apply-lead-sources.ts
 *
 * Three writes, all from the seed:
 *
 *   1. `fieldMapping.lead.referrer`, `leadSource` and `braids` on the
 *      Salesforce connection, so the sync reads the evidence.
 *   2. The `lead_source_rules` config row (`leadChannel` in core).
 *   3. The `lead_exclusion` row with the ZoomInfo outbound rule added. Refused
 *      if the stored row differs from the seed by anything else: once somebody
 *      edits it in production, the seed is the stale copy.
 *
 * Refuses until migrations 0035 and 0036 have added their columns. The data
 * half is `packages/jobs/scripts/backfill-lead-channel.ts`, run after this.
 * `--dry-run` writes inside a transaction, reads everything back and rolls
 * back: under FORCE a denied write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;
const RULES = 'lead_source_rules';
const EXCLUSION = 'lead_exclusion';
const NEW_RULE = 'outbound_zoominfo';

const salesforceSeed = spartan.connections.find((c) => c.platform === 'salesforce');
const seedLead = (salesforceSeed?.config as { fieldMapping?: { lead?: Record<string, unknown> } } | undefined)?.fieldMapping?.lead;
const mappingFields = { referrer: seedLead?.referrer, leadSource: seedLead?.leadSource, braids: seedLead?.braids };
const rules = spartan.config.find((c) => c.key === RULES);
const exclusion = spartan.config.find((c) => c.key === EXCLUSION);
if (!mappingFields.referrer || !mappingFields.leadSource || !mappingFields.braids || !rules || !exclusion) {
  throw new Error('The seed carries no lead evidence mapping, lead_source_rules or lead_exclusion row.');
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

class Rollback extends Error {}

const { db, close } = getOwnerDb();
try {
  const report = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [columns] = await tx.execute<{ n: number }>(
      sql`select count(*)::int n from information_schema.columns
          where table_name = 'leads' and column_name in ('referrer_url', 'channel', 'lead_source', 'braid')`,
    );
    if (Number(columns?.n ?? 0) !== 4) throw new Error('Migrations 0035 and 0036 have not both been applied.');

    const lines: string[] = [];

    // 1. The evidence fields on the lead mapping.
    const connWhere = and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, 'salesforce'));
    const [conn] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(connWhere);
    if (!conn) throw new Error('No Salesforce connection.');
    const config = structuredClone(conn.config ?? {}) as { fieldMapping?: { lead?: Record<string, unknown> } };
    if (!config.fieldMapping?.lead) throw new Error('The Salesforce connection has no lead mapping.');
    Object.assign(config.fieldMapping.lead, mappingFields);
    await tx.update(schema.connections).set({ config }).where(connWhere);
    const [connAfter] = await tx.select({ config: schema.connections.config }).from(schema.connections).where(connWhere);
    const stored = (connAfter?.config as typeof config).fieldMapping?.lead ?? {};
    if (canonical({ referrer: stored.referrer, leadSource: stored.leadSource, braids: stored.braids }) !== canonical(mappingFields)) {
      throw new Error('The lead evidence mapping did not read back — denied.');
    }
    lines.push(`lead mapping: ${canonical(mappingFields)}`);

    // 2 and 3. The two config rows.
    for (const entry of [rules, exclusion]) {
      const where = and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, entry.key));
      const [before] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
      if (entry.key === EXCLUSION) {
        // Only the new rule may differ: anything else is an edit made in production.
        const seedWithout = structuredClone(entry.value) as { rules: { key: string }[] };
        seedWithout.rules = seedWithout.rules.filter((r) => r.key !== NEW_RULE);
        const beforeValue = before?.value as { rules?: { key: string }[] } | undefined;
        const beforeWithout = beforeValue ? { ...beforeValue, rules: (beforeValue.rules ?? []).filter((r) => r.key !== NEW_RULE) } : null;
        if (!beforeWithout || canonical(beforeWithout) !== canonical(seedWithout)) {
          throw new Error(`Refusing to replace ${EXCLUSION}: the stored row differs from the seed by more than the ${NEW_RULE} rule.`);
        }
      }
      await tx
        .insert(schema.tenantConfig)
        .values({ tenantId: tenant.id, key: entry.key, value: entry.value, description: entry.description ?? null })
        .onConflictDoUpdate({
          target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
          set: { value: entry.value, description: entry.description ?? null, updatedAt: new Date() },
        });
      const [after] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(where);
      if (canonical(after?.value) !== canonical(entry.value)) throw new Error(`${entry.key} did not read back — denied.`);
      lines.push(`${entry.key}: ${before ? 'replaced' : 'created'}`);
    }

    // The superseded rule row from the first cut of this change, where present.
    await tx
      .delete(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'organic_search_evidence')));

    if (DRY_RUN) {
      console.log(`Dry run against ${slug}, rolled back:\n  ${lines.join('\n  ')}`);
      throw new Rollback();
    }
    return lines;
  }).catch((e) => {
    if (e instanceof Rollback) return null;
    throw e;
  });
  if (report) console.log(`Applied for ${slug}:\n  ${report.join('\n  ')}`);
} finally {
  await close();
}
