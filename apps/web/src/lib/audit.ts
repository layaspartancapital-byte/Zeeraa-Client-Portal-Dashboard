import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, withUserOnly, type Database } from '@zeeraa/db';
import type { AuditAction } from '@zeeraa/db/schema';
import { queryTenant, type TenantSession } from '@/lib/tenant';

/**
 * The account audit log (migration 0040): who did what to which account, and
 * every sign-in. Append-only for every role — the table takes INSERT and
 * nothing else, and a trigger refuses UPDATE, DELETE and TRUNCATE even to the
 * owner.
 *
 * An account action is written inside the transaction that performs it, by
 * `recordAccountAction`, so the record and the change land or fail together:
 * a reset that happened with no entry, or an entry for a reset that rolled
 * back, cannot exist. `tenant_admin_write` requires the actor to be the
 * signed-in Zeeraa admin, so an entry cannot name somebody else as its author.
 */

export type AccountAction = Exclude<AuditAction, 'sign_in'>;

export async function recordAccountAction(
  tx: Database,
  session: TenantSession,
  event: { action: AccountAction; subjectUserId: string; subjectEmail: string; role?: string | null },
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    tenantId: session.tenant.id,
    action: event.action,
    actorUserId: session.viewer.userId,
    actorEmail: session.viewer.email,
    subjectUserId: event.subjectUserId,
    subjectEmail: event.subjectEmail,
    role: event.role ?? null,
  });
}

/**
 * A sign-in, recorded in every tenant the person holds.
 *
 * Runs as the person themselves with only a user in context — there is no
 * tenant in a sign-in — under `own_sign_in`, which admits their own row in a
 * tenant they are a member of and nothing else. Called before the session is
 * created, so a sign-in that could not be recorded does not happen.
 */
export async function recordSignIn(userId: string, email: string): Promise<void> {
  await withUserOnly(userId, async (tx) => {
    const held = await tx
      .select({ tenantId: schema.memberships.tenantId })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, userId));
    if (held.length === 0) return;
    await tx.insert(schema.auditEvents).values(
      held.map(({ tenantId }) => ({
        tenantId,
        action: 'sign_in' as const,
        actorUserId: userId,
        actorEmail: email,
        subjectUserId: userId,
        subjectEmail: email,
      })),
    );
  });
}

export type AuditEntry = {
  id: string;
  occurredAt: Date;
  action: AuditAction;
  actorEmail: string;
  subjectEmail: string;
  role: string | null;
};

/** The most recent entries for this tenant, newest first. */
export function auditLog(session: TenantSession, limit = 100): Promise<AuditEntry[]> {
  return queryTenant(session, (tx) =>
    tx
      .select({
        id: schema.auditEvents.id,
        occurredAt: schema.auditEvents.occurredAt,
        action: schema.auditEvents.action,
        actorEmail: schema.auditEvents.actorEmail,
        subjectEmail: schema.auditEvents.subjectEmail,
        role: schema.auditEvents.role,
      })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.tenantId, session.tenant.id))
      .orderBy(desc(schema.auditEvents.occurredAt))
      .limit(limit),
  );
}

/** Each member's latest sign-in to this tenant, by user id. */
export async function lastSignIns(session: TenantSession): Promise<Map<string, Date>> {
  const rows = await queryTenant(session, (tx) =>
    tx
      .select({
        userId: schema.auditEvents.subjectUserId,
        at: sql<Date>`max(${schema.auditEvents.occurredAt})`.mapWith((v) => new Date(v)),
      })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.tenantId, session.tenant.id),
          eq(schema.auditEvents.action, 'sign_in'),
        ),
      )
      .groupBy(schema.auditEvents.subjectUserId),
  );
  return new Map(rows.map((r) => [r.userId, r.at]));
}
