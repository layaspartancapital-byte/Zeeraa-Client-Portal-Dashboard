import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../src/client';
import * as schema from '../src/schema/index';
import type { TenantSeed } from './types';

const money = (n: number) => n.toFixed(2);

/**
 * Applies a tenant seed idempotently.
 *
 * Nothing in here knows what a merchant cash advance is. The same function
 * applies a seed whose funnel runs Lead → Demo → Trial → Subscription.
 */
export async function applyTenantSeed(db: Database, seed: TenantSeed): Promise<string> {
  const [tenant] = await db
    .insert(schema.tenants)
    .values(seed.tenant)
    .onConflictDoUpdate({
      target: schema.tenants.slug,
      set: {
        name: seed.tenant.name,
        timezone: seed.tenant.timezone,
        currency: seed.tenant.currency,
        accentColor: seed.tenant.accentColor,
      },
    })
    .returning();
  if (!tenant) throw new Error('tenant upsert returned nothing');
  const tenantId = tenant.id;

  // Positions are unique per tenant, so re-ordering a funnel by upserting each
  // stage in turn collides with itself: the row moving into position 1 hits the
  // row that has not moved out of it yet. Parking every existing stage in a
  // range the seed never uses clears the whole positive range in one statement,
  // and the upserts below then land wherever they like.
  await db
    .update(schema.funnelStages)
    .set({ position: sql`-1000 - ${schema.funnelStages.position}` })
    .where(eq(schema.funnelStages.tenantId, tenantId));

  for (const stage of seed.funnelStages) {
    await db
      .insert(schema.funnelStages)
      .values({
        tenantId,
        position: stage.position,
        key: stage.key,
        label: stage.label,
        isOptimizationTarget: stage.isOptimizationTarget ?? false,
        countsValue: stage.countsValue ?? false,
        source: stage.source ?? 'stage_events',
      })
      .onConflictDoUpdate({
        target: [schema.funnelStages.tenantId, schema.funnelStages.key],
        set: {
          position: stage.position,
          label: stage.label,
          isOptimizationTarget: stage.isOptimizationTarget ?? false,
          countsValue: stage.countsValue ?? false,
          source: stage.source ?? 'stage_events',
        },
      });
  }

  // A stage the seed no longer defines is still sitting in the parking range.
  // Left in place rather than deleted — its stage events are real history and
  // dropping the row would orphan them — but named loudly, because a stage
  // nobody configured will not render and its absence should not be a surprise.
  const orphaned = await db
    .select({ key: schema.funnelStages.key })
    .from(schema.funnelStages)
    .where(and(eq(schema.funnelStages.tenantId, tenantId), lt(schema.funnelStages.position, 0)));
  if (orphaned.length > 0) {
    console.warn(
      `  ${orphaned.length} funnel stage(s) not in the seed and left unpositioned: ` +
        `${orphaned.map((s) => s.key).join(', ')}. ` +
        'Rename them with `pnpm --filter @zeeraa/db rename-stage` or remove them deliberately.',
    );
  }

  for (const metric of seed.metrics) {
    await db
      .insert(schema.tenantMetrics)
      .values({
        tenantId,
        key: metric.key,
        label: metric.label,
        formulaKey: metric.formulaKey,
        formulaArgs: metric.formulaArgs ?? {},
        targetValue: metric.targetValue ?? null,
        improvementDirection: metric.improvementDirection,
        isNorthStar: metric.isNorthStar ?? false,
        needsReconciliation: metric.needsReconciliation ?? false,
        reconciliationNote: metric.reconciliationNote ?? null,
        definition: metric.definition ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.tenantMetrics.tenantId, schema.tenantMetrics.key],
        set: {
          label: metric.label,
          formulaKey: metric.formulaKey,
          formulaArgs: metric.formulaArgs ?? {},
          targetValue: metric.targetValue ?? null,
          improvementDirection: metric.improvementDirection,
          isNorthStar: metric.isNorthStar ?? false,
          needsReconciliation: metric.needsReconciliation ?? false,
          reconciliationNote: metric.reconciliationNote ?? null,
          definition: metric.definition ?? null,
        },
      });
  }

  for (const entry of seed.config) {
    await db
      .insert(schema.tenantConfig)
      .values({
        tenantId,
        key: entry.key,
        value: entry.value,
        description: entry.description ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.tenantConfig.tenantId, schema.tenantConfig.key],
        set: { value: entry.value, description: entry.description ?? null, updatedAt: new Date() },
      });
  }

  for (const baseline of seed.baselines) {
    await db
      .insert(schema.baselines)
      .values({
        tenantId,
        key: baseline.key,
        label: baseline.label,
        platform: baseline.platform ?? null,
        periodStart: baseline.periodStart,
        periodEnd: baseline.periodEnd,
        metrics: baseline.metrics,
        note: baseline.note ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.baselines.tenantId, schema.baselines.key],
        set: { label: baseline.label, metrics: baseline.metrics, note: baseline.note ?? null },
      });
  }

  await Promise.all(
    seed.milestones.ladder.map((threshold, i) =>
      db
        .insert(schema.milestones)
        .values({
          tenantId,
          metricKey: seed.milestones.metricKey,
          position: i + 1,
          label: `$${threshold.toLocaleString('en-US')}`,
          thresholdValue: money(threshold),
        })
        .onConflictDoUpdate({
          target: [
            schema.milestones.tenantId,
            schema.milestones.metricKey,
            schema.milestones.position,
          ],
          set: { thresholdValue: money(threshold), label: `$${threshold.toLocaleString('en-US')}` },
        }),
    ),
  );

  for (const [i, c] of seed.commitments.entries()) {
    await db
      .insert(schema.deliverableCommitments)
      .values({
        tenantId,
        key: c.key,
        label: c.label,
        committedQuantity: money(c.quantity),
        committedQuantityMax: c.quantityMax != null ? money(c.quantityMax) : null,
        period: c.period,
        unit: c.unit,
        requiresClientApproval: c.requiresClientApproval ?? false,
        position: i + 1,
      })
      .onConflictDoUpdate({
        target: [schema.deliverableCommitments.tenantId, schema.deliverableCommitments.key],
        set: {
          label: c.label,
          committedQuantity: money(c.quantity),
          committedQuantityMax: c.quantityMax != null ? money(c.quantityMax) : null,
          period: c.period,
          unit: c.unit,
          requiresClientApproval: c.requiresClientApproval ?? false,
          position: i + 1,
        },
      });
  }

  for (const s of seed.slaCommitments) {
    await db
      .insert(schema.slaCommitments)
      .values({
        tenantId,
        type: s.type,
        label: s.label,
        targetMinutes: s.targetMinutes ?? null,
        cadence: s.cadence ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.slaCommitments.tenantId, schema.slaCommitments.type],
        set: { label: s.label, targetMinutes: s.targetMinutes ?? null, cadence: s.cadence ?? null },
      });
  }

  for (const [i, t] of seed.assetTypes.entries()) {
    await db
      .insert(schema.assetTypes)
      .values({ tenantId, key: t.key, label: t.label, position: i + 1 })
      .onConflictDoUpdate({
        target: [schema.assetTypes.tenantId, schema.assetTypes.key],
        set: { label: t.label, position: i + 1 },
      });
  }

  for (const c of seed.connections) {
    await db
      .insert(schema.connections)
      .values({
        tenantId,
        platform: c.platform,
        accountIdentifier: c.accountIdentifier,
        status: c.status,
        blockedReason: c.blockedReason ?? null,
        blockedSince: c.status === 'waiting_on_client' ? new Date() : null,
        config: c.config ?? {},
      })
      // Configuration is re-applied on every seed; credentials never are. A
      // connection that is already authenticated keeps its credential blob and
      // picks up a corrected field mapping.
      .onConflictDoUpdate({
        target: [
          schema.connections.tenantId,
          schema.connections.platform,
          schema.connections.accountIdentifier,
        ],
        set: {
          status: c.status,
          blockedReason: c.blockedReason ?? null,
          config: c.config ?? {},
          updatedAt: new Date(),
        },
      });
  }

  for (const r of seed.reconciliation) {
    await db
      .insert(schema.reconciliationItems)
      .values({
        tenantId,
        key: r.key,
        label: r.label,
        question: r.question,
        claims: r.claims,
      })
      .onConflictDoUpdate({
        target: [schema.reconciliationItems.tenantId, schema.reconciliationItems.key],
        set: { label: r.label, question: r.question, claims: r.claims },
      });
  }

  for (const b of seed.blockedDependencies) {
    await db
      .insert(schema.blockedDependencies)
      .values({
        tenantId,
        key: b.key,
        subjectKind: b.subjectKind,
        subjectKey: b.subjectKey,
        label: b.label,
        reason: b.reason,
        needed: b.needed ?? null,
        evidence: b.evidence ?? null,
      })
      // `blockedSince` is deliberately not in the update set: re-seeding must
      // not reset how long a dependency has been outstanding. "Outstanding
      // since" is the number that makes a blocked state a conversation rather
      // than a permanent fixture, and a seed run is not progress.
      .onConflictDoUpdate({
        target: [schema.blockedDependencies.tenantId, schema.blockedDependencies.key],
        set: {
          subjectKind: b.subjectKind,
          subjectKey: b.subjectKey,
          label: b.label,
          reason: b.reason,
          needed: b.needed ?? null,
          evidence: b.evidence ?? null,
        },
      });
  }

  /**
   * A dependency dropped from the seed is unblocked.
   *
   * §9.5 wants unblocking to be a delete rather than a deploy, and an upsert
   * alone cannot express removal: UW approved gained a source in
   * `OpportunityFieldHistory`, its seed entry went away, and the row sat in the
   * database still telling the client the stage was not measured. Pruning here
   * makes the seed the whole statement of what is outstanding.
   *
   * Scoped to this tenant, and only to keys the seed governs.
   */
  const seededKeys = seed.blockedDependencies.map((b) => b.key);
  const stale = await db
    .delete(schema.blockedDependencies)
    .where(
      seededKeys.length > 0
        ? and(
            eq(schema.blockedDependencies.tenantId, tenantId),
            notInArray(schema.blockedDependencies.key, seededKeys),
          )
        : eq(schema.blockedDependencies.tenantId, tenantId),
    )
    .returning({ key: schema.blockedDependencies.key });
  for (const row of stale) {
    console.log(`  unblocked (no longer in the seed): ${row.key}`);
  }

  return tenantId;
}

/** Development convenience: attach a user to a tenant with a role. */
export async function ensureMembership(
  db: Database,
  email: string,
  name: string,
  tenantId: string,
  role: 'zeeraa_admin' | 'zeeraa_member' | 'client_admin' | 'client_viewer',
  title?: string,
) {
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email));
  const user =
    existing[0] ??
    (
      await db
        .insert(schema.users)
        .values({ email, name, title: title ?? null })
        .returning()
    )[0];
  if (!user) throw new Error(`could not create user ${email}`);

  await db
    .insert(schema.memberships)
    .values({ userId: user.id, tenantId, role })
    .onConflictDoUpdate({
      target: [schema.memberships.userId, schema.memberships.tenantId],
      set: { role },
    });
  return user.id;
}
