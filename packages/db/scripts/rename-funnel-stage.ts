/**
 * Renames a funnel stage key, and the stage events recorded against it.
 *
 *   pnpm --filter @zeeraa/db rename-stage <tenant-slug> <from-key> <to-key> [--label "New label"]
 *
 * A stage key is tenant configuration, not schema, so this is maintenance
 * rather than a migration: a migration cannot know that one client calls a
 * stage `lead` and another calls it `trial`, and rewriting data on a key a
 * migration guessed at is how one tenant's funnel gets renamed by another
 * tenant's deploy.
 *
 * Both halves move in one transaction. `funnel_stages.key` and
 * `stage_events.stage` are joined by value with no foreign key between them, so
 * renaming one without the other leaves every event orphaned — the stage would
 * render zero, which is a measurement, and the funnel would claim nothing
 * reached it.
 */
import { and, eq } from 'drizzle-orm';
import { getOwnerDb } from '../src/client';
import { withMaintenance } from '../src/tenant-context';
import * as schema from '../src/schema/index';

const args = process.argv.slice(2);
const [slug, fromKey, toKey] = args;
if (!slug || !fromKey || !toKey) {
  throw new Error(
    'Usage: tsx scripts/rename-funnel-stage.ts <tenant-slug> <from-key> <to-key> [--label "New label"]',
  );
}
const labelIndex = args.indexOf('--label');
const newLabel = labelIndex === -1 ? undefined : args[labelIndex + 1];

const { db, close } = getOwnerDb();

try {
  await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [stage] = await tx
      .select()
      .from(schema.funnelStages)
      .where(
        and(eq(schema.funnelStages.tenantId, tenant.id), eq(schema.funnelStages.key, fromKey)),
      );
    if (!stage) throw new Error(`${tenant.name} has no funnel stage "${fromKey}".`);

    const [clash] = await tx
      .select({ id: schema.funnelStages.id })
      .from(schema.funnelStages)
      .where(and(eq(schema.funnelStages.tenantId, tenant.id), eq(schema.funnelStages.key, toKey)));
    if (clash) {
      throw new Error(
        `${tenant.name} already has a stage "${toKey}". Merging two stages is not a ` +
          'rename — decide which events belong where before running this.',
      );
    }

    const events = await tx
      .update(schema.stageEvents)
      .set({ stage: toKey })
      .where(
        and(eq(schema.stageEvents.tenantId, tenant.id), eq(schema.stageEvents.stage, fromKey)),
      )
      .returning({ id: schema.stageEvents.id });

    await tx
      .update(schema.funnelStages)
      .set({ key: toKey, ...(newLabel ? { label: newLabel } : {}) })
      .where(eq(schema.funnelStages.id, stage.id));

    // Blocked dependencies point at a stage by key too, and a dependency left
    // pointing at a key nothing uses stops rendering — the gap goes silent,
    // which is the one outcome §9.5 exists to prevent.
    const blocked = await tx
      .update(schema.blockedDependencies)
      .set({ subjectKey: toKey })
      .where(
        and(
          eq(schema.blockedDependencies.tenantId, tenant.id),
          eq(schema.blockedDependencies.subjectKind, 'funnel_stage'),
          eq(schema.blockedDependencies.subjectKey, fromKey),
        ),
      )
      .returning({ id: schema.blockedDependencies.id });

    console.log(`${tenant.name}: ${fromKey} → ${toKey}${newLabel ? ` ("${newLabel}")` : ''}`);
    console.log(`  stage events moved:        ${events.length}`);
    console.log(`  blocked dependencies moved: ${blocked.length}`);
    console.log(
      '  Note: the connection’s fieldMapping.derivedStages and the tenant seed ' +
        'both name stage keys. Update them too, or the next sync writes the old key back.',
    );
  });
} finally {
  await close();
}
