/**
 * Readies a tenant for LinkedIn Ads, and touches nothing else.
 *
 *   pnpm --filter @zeeraa/db configure-linkedin [--dry-run]
 *
 * Three merge-in writes, all from the seed, each read back:
 *
 *   1. The `linkedin_ads` connection: account identifier and config (ad
 *      account, API version, click and conversion metrics). Credentials and
 *      status are left alone — those come from pressing Connect.
 *   2. `li_fat_id` in `lead_source_rules.referrerParams.linkedin_ads`, added
 *      to the stored row rather than replacing it, so a production edit to
 *      any other rule survives.
 *   3. `Li_Fat_ID__c` in the Salesforce connection's
 *      `fieldMapping.lead.clickIds.linkedin_ads`, likewise merged in.
 *
 * `--dry-run` writes inside a transaction, reads back and rolls back: every
 * table here is FORCE RLS'd, so a denied write matches nothing and exits 0.
 * Run `backfill-lead-channel` after, so stored leads are re-read.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;

const seedLinkedIn = spartan.connections.find((c) => c.platform === 'linkedin_ads');
const seedRules = spartan.config.find((c) => c.key === 'lead_source_rules')?.value as
  | { referrerParams?: Record<string, string[]> }
  | undefined;
const seedSalesforce = spartan.connections.find((c) => c.platform === 'salesforce')?.config as
  | { fieldMapping?: { lead?: { clickIds?: Record<string, string> } } }
  | undefined;
const liParams = seedRules?.referrerParams?.linkedin_ads;
const liField = seedSalesforce?.fieldMapping?.lead?.clickIds?.linkedin_ads;
if (!seedLinkedIn?.config || !liParams?.length || !liField) {
  throw new Error('The seed carries no LinkedIn connection config, li_fat_id rule or Lead click-ID field.');
}

class Rollback extends Error {}
const { db, close } = getOwnerDb();

try {
  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const byPlatform = async (platform: string) =>
      (
        await tx
          .select()
          .from(schema.connections)
          .where(and(eq(schema.connections.tenantId, tenant.id), eq(schema.connections.platform, platform)))
      )[0];

    // 1. The connection.
    const linkedin = await byPlatform('linkedin_ads');
    const config = { ...((linkedin?.config ?? {}) as Record<string, unknown>), ...(seedLinkedIn.config as Record<string, unknown>) };
    if (linkedin) {
      await tx
        .update(schema.connections)
        .set({ accountIdentifier: seedLinkedIn.accountIdentifier, config, updatedAt: new Date() })
        .where(eq(schema.connections.id, linkedin.id));
    } else {
      await tx.insert(schema.connections).values({
        tenantId: tenant.id,
        platform: 'linkedin_ads',
        accountIdentifier: seedLinkedIn.accountIdentifier,
        config,
        status: 'not_configured',
      });
    }

    // 2. li_fat_id as click evidence on the landing URL.
    const [rulesRow] = await tx
      .select()
      .from(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'lead_source_rules')));
    if (!rulesRow) throw new Error('No lead_source_rules row; apply-lead-sources first.');
    const rules = rulesRow.value as { referrerParams?: Record<string, string[]> };
    const nextRules = {
      ...rules,
      referrerParams: {
        ...(rules.referrerParams ?? {}),
        linkedin_ads: [...new Set([...(rules.referrerParams?.linkedin_ads ?? []), ...liParams])],
      },
    };
    await tx
      .update(schema.tenantConfig)
      .set({ value: nextRules, updatedAt: new Date() })
      .where(and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'lead_source_rules')));

    // 3. The Salesforce Lead field.
    const salesforce = await byPlatform('salesforce');
    if (!salesforce) throw new Error('No Salesforce connection.');
    const sfConfig = salesforce.config as { fieldMapping?: { lead?: { clickIds?: Record<string, string> } } };
    if (!sfConfig.fieldMapping?.lead) throw new Error('The Salesforce connection has no Lead field mapping.');
    const nextSf = {
      ...sfConfig,
      fieldMapping: {
        ...sfConfig.fieldMapping,
        lead: { ...sfConfig.fieldMapping.lead, clickIds: { ...(sfConfig.fieldMapping.lead.clickIds ?? {}), linkedin_ads: liField } },
      },
    };
    await tx.update(schema.connections).set({ config: nextSf, updatedAt: new Date() }).where(eq(schema.connections.id, salesforce.id));

    // Read everything back: under FORCE a refused write leaves no trace.
    const after = {
      linkedin: (await byPlatform('linkedin_ads'))!,
      rules: (
        await tx
          .select()
          .from(schema.tenantConfig)
          .where(and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'lead_source_rules')))
      )[0]!.value as { referrerParams?: Record<string, string[]> },
      salesforce: (await byPlatform('salesforce'))!.config as typeof sfConfig,
    };
    const ok =
      (after.linkedin.config as { adAccountId?: string }).adAccountId === (seedLinkedIn.config as { adAccountId: string }).adAccountId &&
      after.rules.referrerParams?.linkedin_ads?.includes('li_fat_id') &&
      after.salesforce.fieldMapping?.lead?.clickIds?.linkedin_ads === liField;
    if (!ok) throw new Error('Refusing to commit: a write did not read back. Check this role is in zeeraa_maintenance.');

    const result = {
      tenant: `${tenant.name} (${slug})`,
      linkedin: { accountIdentifier: after.linkedin.accountIdentifier, status: after.linkedin.status, config: after.linkedin.config },
      referrerParams: after.rules.referrerParams,
      leadClickIds: after.salesforce.fieldMapping?.lead?.clickIds,
    };
    if (DRY_RUN) {
      console.log('Would write:', JSON.stringify(result, null, 2));
      throw new Rollback();
    }
    return result;
  }).catch((error) => {
    if (error instanceof Rollback) return null;
    throw error;
  });

  if (summary === null) console.log(`Dry run against ${slug}: every write lands and was rolled back.`);
  else console.log('Configured:', JSON.stringify(summary, null, 2));
} finally {
  await close();
}
