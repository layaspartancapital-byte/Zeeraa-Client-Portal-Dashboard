/**
 * Merges one funnel stage into another: the stage row goes, and a
 * `stage_merges` rule says its events count toward the other.
 *
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/merge-funnel-stage.ts spartan offer uw_approved --dry-run
 *   DATABASE_URL_OWNER=… npx tsx packages/db/scripts/merge-funnel-stage.ts spartan offer uw_approved
 *
 * Not a rename (`rename-funnel-stage.ts`): the merged stage's events stay
 * stored as themselves, because they are what the CRM records and the
 * reconciliation still checks them. The next Salesforce sync reads the rule
 * and writes an event of the kept stage wherever the merged one came first
 * (`applyStageMerges` in `@zeeraa/jobs`).
 *
 * `--dry-run` writes, reads both writes back and rolls back: `funnel_stages`
 * and `tenant_config` are FORCE RLS'd, so a denied write matches nothing and
 * exits 0. Frozen baseline figures for the merged stage are not touched here;
 * retire them with `freeze-baseline --correct-channel-figures --retire-missing`.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DRY_RUN = process.argv.includes('--dry-run');
const [slug, fromKey, intoKey] = args;
if (!slug || !fromKey || !intoKey || fromKey === intoKey) {
  console.error('Usage: merge-funnel-stage.ts <slug> <merged-stage> <kept-stage> [--dry-run]');
  process.exit(2);
}

type Merge = { into: string; from: string[] };
class Rollback extends Error {}
const { db, close } = getOwnerDb();

try {
  await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    const stageWhere = (key: string) =>
      and(eq(schema.funnelStages.tenantId, tenant.id), eq(schema.funnelStages.key, key));
    const [kept] = await tx.select().from(schema.funnelStages).where(stageWhere(intoKey));
    if (!kept) throw new Error(`${tenant.name} has no funnel stage "${intoKey}" to merge into.`);

    // The rule, added to whatever the row already holds.
    const configWhere = and(eq(schema.tenantConfig.tenantId, tenant.id), eq(schema.tenantConfig.key, 'stage_merges'));
    const [row] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(configWhere);
    const merges: Merge[] = ((row?.value as { merges?: Merge[] } | undefined)?.merges ?? []).map((m) => ({ ...m }));
    const existing = merges.find((m) => m.into === intoKey);
    if (existing) existing.from = [...new Set([...existing.from, fromKey])];
    else merges.push({ into: intoKey, from: [fromKey] });
    await tx
      .insert(schema.tenantConfig)
      .values({
        tenantId: tenant.id,
        key: 'stage_merges',
        value: { merges },
        description:
          'Stages that are one step: a deal reaches `into` at the earliest of its `into` ' +
          'and `from` events. The `from` events stay stored as themselves.',
      })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: { merges }, updatedAt: new Date() },
      });

    const removed = await tx
      .delete(schema.funnelStages)
      .where(stageWhere(fromKey))
      .returning({ id: schema.funnelStages.id, label: schema.funnelStages.label });

    // Read back: under FORCE a denied write leaves both tables as they were.
    const [after] = await tx.select({ value: schema.tenantConfig.value }).from(schema.tenantConfig).where(configWhere);
    const [still] = await tx.select({ id: schema.funnelStages.id }).from(schema.funnelStages).where(stageWhere(fromKey));
    const ruleLanded = JSON.stringify((after?.value as { merges?: Merge[] })?.merges ?? []) === JSON.stringify(merges);
    if (!ruleLanded || still) {
      throw new Error(
        'Refusing to commit: a write did not read back. A write that matched nothing is the ' +
          'signature of row level security denying it.',
      );
    }
    console.log(`${tenant.name}: ${fromKey} merged into ${intoKey}${DRY_RUN ? ' (dry run)' : ''}`);
    console.log(`  stage_merges: ${JSON.stringify(merges)}`);
    console.log(`  funnel stage removed: ${removed.length ? `${fromKey} ("${removed[0]!.label}")` : 'none — already gone'}`);
    if (DRY_RUN) throw new Rollback();
  }).catch((error) => {
    if (error instanceof Rollback) return console.log('Rolled back. Nothing changed.');
    throw error;
  });
} finally {
  await close();
}
