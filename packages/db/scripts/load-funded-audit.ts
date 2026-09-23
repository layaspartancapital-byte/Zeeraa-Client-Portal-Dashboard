/**
 * Loads the configuration the 23 September 2026 funded-deal audit decided, and
 * nothing else.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-funded-audit.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-funded-audit.ts
 *
 * Targeted rather than `db:seed`, for the reason `load-engagement-targets.ts`
 * gives: the seed rewrites every `tenant_config` row and would reset
 * `engagement_start_month`. Each unit below is named, read from the seed
 * constant, and read back afterwards:
 *
 *   * the Salesforce field mapping gains `opportunity.fundedAmount` and
 *     `opportunity.dealType` — merged into the stored mapping, so nothing else
 *     in it is touched;
 *   * `tenant_config` gains `stage_exclusions` (renewals) and
 *     `stage_corrections` (eOpyP funded in May);
 *   * `tenant_metrics` for cost per funded deal, funded volume and CPA are
 *     settled by the engagement model — no longer awaiting reconciliation;
 *   * `reconciliation_items` `cpa_definition` and `funded_targets` resolved;
 *   * `blocked_dependencies`: the stale `mql_time_in_business_decode` removed,
 *     `mql_revenue_coverage` and `revenue_band_breakdown` written as measured.
 *
 * The engagement model's funded amounts are `load-engagement-targets.ts`, run
 * after this. Corrections and exclusions take effect at the next Salesforce
 * sync, which also fills `deal_type` and the funded amount.
 *
 * **`--dry-run` writes inside a transaction and rolls it back**, after printing
 * what it read back. Every table here is FORCE RLS'd, so a write by a role
 * holding no policy matches nothing and exits 0 — the dry run is how you know
 * the write lands.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { resolutionOf } from '../seeds/apply';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;

const CONFIG_KEYS = ['stage_exclusions', 'stage_corrections'];
const METRIC_KEYS = ['cost_per_funded_deal', 'funded_volume', 'cpa'];
const RECONCILED_KEYS = ['cpa_definition', 'funded_targets'];
const BLOCKED_WRITE = ['mql_revenue_coverage', 'revenue_band_breakdown'];
const BLOCKED_REMOVE = ['mql_time_in_business_decode'];
const MAPPING_KEYS = ['fundedAmount', 'dealType'] as const;

class Rollback extends Error {}

function pick<T extends { key: string }>(list: readonly T[], keys: string[]): T[] {
  const found = list.filter((x) => keys.includes(x.key));
  const missing = keys.filter((k) => !found.some((x) => x.key === k));
  if (missing.length > 0) throw new Error(`The seed carries no ${missing.join(', ')}.`);
  return found;
}

const { db, close } = getOwnerDb();

try {
  const [column] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'stage_events'
      and column_name in ('excluded_reason', 'occurred_on', 'correction_source')
  `);
  if (Number(column?.n) !== 3) {
    throw new Error(
      'Refusing to load: stage_events has no excluded_reason / occurred_on / ' +
        'correction_source, so the rules have nothing to write to. Apply migration 0024 first.',
    );
  }

  const configRows = pick(spartan.config, CONFIG_KEYS);
  const metricRows = pick(spartan.metrics, METRIC_KEYS);
  const reconciled = pick(spartan.reconciliation, RECONCILED_KEYS);
  const blockedRows = pick(spartan.blockedDependencies, BLOCKED_WRITE);
  if (spartan.blockedDependencies.some((b) => BLOCKED_REMOVE.includes(b.key))) {
    throw new Error(`The seed still carries ${BLOCKED_REMOVE.join(', ')}; it cannot be removed.`);
  }
  if (reconciled.some((r) => !r.resolution)) {
    throw new Error('A reconciliation item this script resolves has no resolution in the seed.');
  }
  const sfSeed = spartan.connections.find((c) => c.platform === 'salesforce');
  const seedOpportunity = (sfSeed?.config?.fieldMapping as { opportunity?: Record<string, unknown> })
    ?.opportunity;
  if (!seedOpportunity || MAPPING_KEYS.some((k) => typeof seedOpportunity[k] !== 'string')) {
    throw new Error('The seed Salesforce mapping does not name fundedAmount and dealType.');
  }

  await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const tenantId = tenant.id;

    // --- Field mapping, merged ------------------------------------------------
    const connections = await tx
      .select({ id: schema.connections.id, config: schema.connections.config })
      .from(schema.connections)
      .where(and(eq(schema.connections.tenantId, tenantId), eq(schema.connections.platform, 'salesforce')));
    if (connections.length !== 1) {
      throw new Error(`Expected one Salesforce connection, found ${connections.length}.`);
    }
    const connection = connections[0]!;
    const config = connection.config as { fieldMapping?: { opportunity?: Record<string, unknown> } };
    if (!config.fieldMapping?.opportunity) throw new Error('The stored mapping has no opportunity section.');
    const mergedOpportunity = { ...config.fieldMapping.opportunity };
    for (const k of MAPPING_KEYS) mergedOpportunity[k] = seedOpportunity[k];
    await tx
      .update(schema.connections)
      .set({
        config: { ...config, fieldMapping: { ...config.fieldMapping, opportunity: mergedOpportunity } },
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connection.id));

    // --- Config rows ----------------------------------------------------------
    for (const entry of configRows) {
      await tx
        .insert(schema.tenantConfig)
        .values({ tenantId, key: entry.key, value: entry.value, description: entry.description ?? null })
        .onConflictDoUpdate({
          target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
          set: { value: entry.value, description: entry.description ?? null, updatedAt: new Date() },
        });
    }

    // --- Metrics, settled -----------------------------------------------------
    for (const metric of metricRows) {
      const updated = await tx
        .update(schema.tenantMetrics)
        .set({
          label: metric.label,
          formulaArgs: metric.formulaArgs ?? {},
          targetValue: metric.targetValue ?? null,
          needsReconciliation: metric.needsReconciliation ?? false,
          reconciliationNote: metric.reconciliationNote ?? null,
          definition: metric.definition ?? null,
        })
        .where(and(eq(schema.tenantMetrics.tenantId, tenantId), eq(schema.tenantMetrics.key, metric.key)))
        .returning({ key: schema.tenantMetrics.key });
      if (updated.length !== 1) throw new Error(`tenant_metrics.${metric.key}: ${updated.length} rows updated.`);
    }

    // --- Reconciliation, resolved --------------------------------------------
    for (const item of reconciled) {
      const updated = await tx
        .update(schema.reconciliationItems)
        .set({ claims: item.claims, question: item.question, ...resolutionOf(item) })
        .where(
          and(eq(schema.reconciliationItems.tenantId, tenantId), eq(schema.reconciliationItems.key, item.key)),
        )
        .returning({ key: schema.reconciliationItems.key });
      if (updated.length !== 1) throw new Error(`reconciliation_items.${item.key}: ${updated.length} rows.`);
    }

    // --- Blocked dependencies -------------------------------------------------
    const removed = await tx
      .delete(schema.blockedDependencies)
      .where(
        and(
          eq(schema.blockedDependencies.tenantId, tenantId),
          inArray(schema.blockedDependencies.key, BLOCKED_REMOVE),
        ),
      )
      .returning({ key: schema.blockedDependencies.key });
    for (const b of blockedRows) {
      const values = {
        subjectKind: b.subjectKind,
        subjectKey: b.subjectKey,
        label: b.label,
        reason: b.reason,
        needed: b.needed ?? null,
        evidence: b.evidence ?? null,
      };
      await tx
        .insert(schema.blockedDependencies)
        .values({ tenantId, key: b.key, ...values })
        .onConflictDoUpdate({
          target: [schema.blockedDependencies.tenantId, schema.blockedDependencies.key],
          set: values,
        });
    }

    // --- Read back ------------------------------------------------------------
    const [conn] = await tx
      .select({ config: schema.connections.config })
      .from(schema.connections)
      .where(eq(schema.connections.id, connection.id));
    const opp = (conn!.config as typeof config).fieldMapping!.opportunity!;
    const cfg = await tx
      .select({ key: schema.tenantConfig.key })
      .from(schema.tenantConfig)
      .where(and(eq(schema.tenantConfig.tenantId, tenantId), inArray(schema.tenantConfig.key, CONFIG_KEYS)));
    const metrics = await tx
      .select({ key: schema.tenantMetrics.key, open: schema.tenantMetrics.needsReconciliation, args: schema.tenantMetrics.formulaArgs })
      .from(schema.tenantMetrics)
      .where(and(eq(schema.tenantMetrics.tenantId, tenantId), inArray(schema.tenantMetrics.key, METRIC_KEYS)));
    const recon = await tx
      .select({ key: schema.reconciliationItems.key, resolved: schema.reconciliationItems.resolvedValue })
      .from(schema.reconciliationItems)
      .where(and(eq(schema.reconciliationItems.tenantId, tenantId), inArray(schema.reconciliationItems.key, RECONCILED_KEYS)));
    const blocked = await tx
      .select({ key: schema.blockedDependencies.key })
      .from(schema.blockedDependencies)
      .where(eq(schema.blockedDependencies.tenantId, tenantId));

    const problems = [
      ...MAPPING_KEYS.filter((k) => opp[k] !== seedOpportunity[k]).map((k) => `mapping ${k}`),
      ...CONFIG_KEYS.filter((k) => !cfg.some((c) => c.key === k)).map((k) => `config ${k}`),
      ...metrics.filter((m) => m.open).map((m) => `metric ${m.key} still open`),
      ...(metrics.length !== METRIC_KEYS.length ? ['metrics missing'] : []),
      ...recon.filter((r) => !r.resolved).map((r) => `reconciliation ${r.key} unresolved`),
      ...BLOCKED_WRITE.filter((k) => !blocked.some((b) => b.key === k)).map((k) => `blocked ${k} absent`),
      ...BLOCKED_REMOVE.filter((k) => blocked.some((b) => b.key === k)).map((k) => `blocked ${k} still present`),
    ];

    console.log(`${DRY_RUN ? 'Dry run' : 'Loaded'} for ${tenant.name} (${slug}):`);
    console.log(`  mapping:        fundedAmount=${String(opp.fundedAmount)} dealType=${String(opp.dealType)}`);
    console.log(`  config:         ${cfg.map((c) => c.key).join(', ')}`);
    console.table(metrics.map((m) => ({ key: m.key, open: m.open, args: JSON.stringify(m.args) })));
    console.log(`  resolved:       ${recon.map((r) => r.key).join(', ')}`);
    console.log(`  blocked now:    ${blocked.map((b) => b.key).join(', ')}`);
    console.log(`  blocked removed: ${removed.map((r) => r.key).join(', ') || 'none (already gone)'}`);

    if (problems.length > 0) {
      throw new Error(
        `Refusing to commit — the read-back disagrees: ${problems.join('; ')}. A write that ` +
          'matched nothing is the signature of row level security denying it.',
      );
    }
    if (DRY_RUN) throw new Rollback();
  }).catch((error) => {
    if (error instanceof Rollback) {
      console.log('Rolled back. Nothing changed.');
      return;
    }
    throw error;
  });
} finally {
  await close();
}
