/**
 * Loads one tenant's contracted ramp into `engagement_targets`, and nothing
 * else.
 *
 * `db:seed` would also do this, and against a hosted database it is the wrong
 * tool: it rewrites every `tenant_config` row from the seed constant, so it
 * would reset `engagement_start_month` to null the day somebody records the
 * real one. Eight rows in one table should not carry that blast radius.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-engagement-targets.ts --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/load-engagement-targets.ts
 *
 * Two safeguards, both earned:
 *
 *   * **`--dry-run` writes inside a transaction and rolls it back**, reporting
 *     what changed. Every tenant-scoped table here carries FORCE ROW LEVEL
 *     SECURITY, so a write by a role holding no policy on the table matches
 *     nothing, reports success and changes nothing. That failure is invisible
 *     from the outside — the command exits 0 — so the dry run proves the write
 *     lands before the real one is trusted.
 *   * **It refuses while `approvals` or `funded_deals` is still an integer.**
 *     The model contracts 7.5 funded deals in M1; loading that into an integer
 *     column rounds it to 8 and turns the contracted $4,000 cost per funded
 *     deal into $3,750. Migration 0021 widens both, and this is the guard that
 *     makes "migrate first" enforced rather than remembered.
 */
import { eq, sql } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';
import { spartan } from '../seeds/spartan';

const DRY_RUN = process.argv.includes('--dry-run');
const slug = process.env.TENANT_SLUG ?? spartan.tenant.slug;

/** The rollback signal for a dry run. Not an error anybody needs to see. */
class Rollback extends Error {}

const { db, close } = getOwnerDb();

try {
  const columns = await db.execute<{ column_name: string; data_type: string }>(sql`
    select column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'engagement_targets'
      and column_name in ('approvals', 'funded_deals')
    order by column_name
  `);

  const notNumeric = [...columns].filter((c) => c.data_type !== 'numeric');
  if (notNumeric.length > 0) {
    throw new Error(
      `Refusing to load: ${notNumeric
        .map((c) => `engagement_targets.${c.column_name} is ${c.data_type}`)
        .join(', ')}. The model contracts fractional projections — 7.5 funded ` +
        'deals in M1 — and an integer column would round them, restating the ' +
        'contract. Apply migration 0021 first.',
    );
  }

  const targets = spartan.engagementTargets;
  if (targets.length === 0) throw new Error('The seed carries no engagement targets.');

  const summary = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const before = await tx
      .select()
      .from(schema.engagementTargets)
      .where(eq(schema.engagementTargets.tenantId, tenant.id));

    for (const t of targets) {
      const values = {
        tenantId: tenant.id,
        platform: t.platform,
        monthIndex: t.monthIndex,
        costPerFundedDeal: t.costPerFundedDeal != null ? t.costPerFundedDeal.toFixed(2) : null,
        budget: t.budget != null ? t.budget.toFixed(2) : null,
        cpa: t.cpa != null ? t.cpa.toFixed(2) : null,
        approvals: t.approvals != null ? t.approvals.toFixed(2) : null,
        fundedDeals: t.fundedDeals != null ? t.fundedDeals.toFixed(2) : null,
      };
      await tx
        .insert(schema.engagementTargets)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.engagementTargets.tenantId,
            schema.engagementTargets.platform,
            schema.engagementTargets.monthIndex,
          ],
          set: {
            costPerFundedDeal: values.costPerFundedDeal,
            budget: values.budget,
            cpa: values.cpa,
            approvals: values.approvals,
            fundedDeals: values.fundedDeals,
          },
        });
    }

    // Read back inside the same transaction. This is the check that the write
    // was not silently filtered: under FORCE, a denied write leaves the table
    // exactly as it was and raises nothing.
    const after = await tx
      .select()
      .from(schema.engagementTargets)
      .where(eq(schema.engagementTargets.tenantId, tenant.id))
      .orderBy(schema.engagementTargets.platform, schema.engagementTargets.monthIndex);

    const filled = after.filter(
      (r) => r.budget && r.cpa && r.approvals && r.costPerFundedDeal && r.fundedDeals,
    ).length;

    const result = {
      tenant: `${tenant.name} (${slug})`,
      rowsBefore: before.length,
      rowsAfter: after.length,
      rowsFullyPopulated: filled,
      rows: after.map((r) => ({
        month: `M${r.monthIndex}`,
        budget: r.budget,
        cpa: r.cpa,
        approvals: r.approvals,
        cpf: r.costPerFundedDeal,
        funded: r.fundedDeals,
      })),
    };

    if (filled !== targets.length) {
      throw new Error(
        `Refusing to commit: expected ${targets.length} fully populated rows, found ${filled}. ` +
          'A write that matched nothing is the signature of row level security ' +
          'denying it — check that this role is a member of zeeraa_maintenance.',
      );
    }

    if (DRY_RUN) throw new Rollback();
    return result;
  }).catch((error) => {
    if (error instanceof Rollback) return null;
    throw error;
  });

  if (summary === null) {
    console.log(`Dry run against ${slug}: the write lands and was rolled back. Nothing changed.`);
  } else {
    console.log(`Loaded ${targets.length} engagement targets for ${summary.tenant}`);
    console.log(
      `  rows ${summary.rowsBefore} → ${summary.rowsAfter}, fully populated ${summary.rowsFullyPopulated}`,
    );
    console.table(summary.rows);
  }
} finally {
  await close();
}
