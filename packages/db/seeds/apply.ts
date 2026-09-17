import { eq } from 'drizzle-orm';
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
      })
      .onConflictDoUpdate({
        target: [schema.funnelStages.tenantId, schema.funnelStages.key],
        set: {
          position: stage.position,
          label: stage.label,
          isOptimizationTarget: stage.isOptimizationTarget ?? false,
          countsValue: stage.countsValue ?? false,
        },
      });
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
