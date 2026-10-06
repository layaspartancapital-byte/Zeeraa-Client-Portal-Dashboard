import { eq, sql } from 'drizzle-orm';
import { tenantDay } from '@zeeraa/core';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { recordSyncedDays } from './sync-runs';

/**
 * Recording that a webhook endpoint was reached.
 *
 * A pushed source has no sync run to fail, so its silence has no shape. The
 * Aloware endpoint refused every post for four days, twice, for two unrelated
 * reasons — and neither was answerable from the database, because a rejected
 * delivery returns 200 (a sender retries a non-2xx forever), counts its reasons
 * into the response body and discards them. "Aloware has never called us" and
 * "Aloware calls us three hundred times a day and we refuse every one" looked
 * identical from here: an empty `calls` table.
 *
 * This makes them different rows. It is a diagnostic, so it is written on a
 * best-effort basis and **never fails a delivery**: a counter that cannot be
 * written is a worse outcome than a call that is not counted, but it is not a
 * reason to hand Aloware a 500 and have it retry a post we already ingested.
 */

/** Who posted, and what the post looked like — both optional. */
type Attribution = {
  /** `aloware`, `zapier`, `unknown`: counted separately in `senders`. */
  sender?: string;
  /** A redacted description of the post, kept as the sender's latest sample. */
  sample?: unknown;
};

/** What happened to one POST. */
export type DeliveryOutcome =
  /** Refused before any record was read: no secret, wrong secret, bad body. */
  | ({ kind: 'refused'; reason: string } & Attribution)
  /**
   * The reader ran. Counts are records, not requests.
   *
   * `accepted` is what the reader took, and is what the sender's own counts
   * show. `written` is how many reached `calls` (fewer for a sender still in
   * shadow) and is what marks the day covered. `inserted` is how many of
   * those were new calls, and is what the bucket's `accepted` column adds:
   * while two senders deliver every call, counting each upsert would double
   * the figure the reconciliation compares with stored calls. Both default to
   * `accepted`.
   */
  | ({
      kind: 'read';
      accepted: number;
      written?: number;
      inserted?: number;
      rejected: { reason: string; count: number }[];
    } & Attribution);

export type SenderCounts = { received: number; accepted: number; rejected: number; refused: number };

/** Add one delivery to the sender's counts. Bounded: one key per sender, three senders. */
export function mergeSenders(
  stored: Record<string, unknown>,
  sender: string,
  delta: { accepted: number; rejected: number; refused: number },
): Record<string, SenderCounts> {
  const merged: Record<string, SenderCounts> = {};
  for (const [key, value] of Object.entries(stored)) {
    const v = (value ?? {}) as Partial<Record<keyof SenderCounts, unknown>>;
    merged[key] = {
      received: Number(v.received) || 0,
      accepted: Number(v.accepted) || 0,
      rejected: Number(v.rejected) || 0,
      refused: Number(v.refused) || 0,
    };
  }
  const key = ['aloware', 'zapier'].includes(sender) ? sender : 'unknown';
  const row = merged[key] ?? { received: 0, accepted: 0, rejected: 0, refused: 0 };
  merged[key] = {
    received: row.received + 1,
    accepted: row.accepted + delta.accepted,
    rejected: row.rejected + delta.rejected,
    refused: row.refused + delta.refused,
  };
  return merged;
}

/**
 * How many distinct reasons one day's bucket will hold.
 *
 * A rejection reason quotes the value that caused it — `not a call (2)` — which
 * is what makes the log actionable and also what makes it unbounded if a vendor
 * starts sending junk. Past the cap the rest accumulate under one key, so the
 * row stays a fixed size and the fact that something is being refused survives.
 */
const MAX_REASONS = 40;
/** Long enough for a disposition, short enough that a stray body cannot bloat. */
const MAX_REASON_LENGTH = 120;

function truncate(reason: string): string {
  const text = reason.trim() || '(no reason given)';
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

export function tally(outcome: DeliveryOutcome): Record<string, number> {
  if (outcome.kind === 'refused') return { [truncate(outcome.reason)]: 1 };
  const counts: Record<string, number> = {};
  for (const { reason, count } of outcome.rejected) {
    const key = truncate(reason);
    counts[key] = (counts[key] ?? 0) + count;
  }
  return counts;
}

/**
 * Merge today's reasons into the stored ones, capped.
 *
 * Done here rather than in SQL because the cap needs to see both sides, and a
 * jsonb merge that can silently grow without limit is the thing being avoided.
 */
export function mergeReasons(
  stored: Record<string, unknown>,
  incoming: Record<string, number>,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [key, value] of Object.entries(stored)) {
    const count = Number(value);
    if (Number.isFinite(count)) merged[key] = count;
  }
  for (const [key, count] of Object.entries(incoming)) {
    if (key in merged || Object.keys(merged).length < MAX_REASONS) {
      merged[key] = (merged[key] ?? 0) + count;
    } else {
      // The cap is reached and this reason is new. The count survives; the
      // wording does not, which is the right half to lose.
      merged['(other reasons)'] = (merged['(other reasons)'] ?? 0) + count;
    }
  }
  return merged;
}

/**
 * One delivery, counted into the tenant's bucket for today.
 *
 * Returns whether it was recorded, for the tests. The caller ignores it: a
 * diagnostic that can fail a request is not a diagnostic.
 */
export async function recordWebhookDelivery(
  slug: string,
  source: string,
  outcome: DeliveryOutcome,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    /*
     * The tenant lookup runs on the maintenance role, reading two columns —
     * the same orchestration read `ingestCallEvents` makes, and for the same
     * reason: which tenant a post belongs to cannot be answered from inside a
     * tenant. The write below is `withJobTenant`.
     *
     * An unknown slug resolves to nothing and records nothing, which is also
     * what keeps this table out of reach of somebody probing slugs: only a real
     * tenant gets a row, and a real tenant gets at most one per source per day.
     */
    const tenant = await withMaintenance(getMaintenanceDb(), async (tx) => {
      const [row] = await tx
        .select({ id: schema.tenants.id, timezone: schema.tenants.timezone })
        .from(schema.tenants)
        .where(eq(schema.tenants.slug, slug));
      return row ?? null;
    });
    if (!tenant) return false;

    const day = tenantDay(now, tenant.timezone);
    const counts = tally(outcome);
    const accepted = outcome.kind === 'read' ? outcome.accepted : 0;
    const written = outcome.kind === 'read' ? outcome.written ?? outcome.accepted : 0;
    const inserted = outcome.kind === 'read' ? outcome.inserted ?? written : 0;
    const rejected =
      outcome.kind === 'read' ? outcome.rejected.reduce((n, r) => n + r.count, 0) : 0;
    const sender = outcome.sender ?? 'unknown';
    const sampleKey = `${['aloware', 'zapier'].includes(sender) ? sender : 'unknown'}:${
      outcome.kind === 'refused' ? 'refused' : 'read'
    }`;

    await withJobTenant(tenant.id, async (tx) => {
      // A day the endpoint accepted calls on is a day calls were read: the
      // coverage ledger's evidence that the pushed source was live, so a day
      // it was not reads as `Not measured` rather than as a quiet phone.
      if (written > 0) {
        await recordSyncedDays(tx, tenant.id, 'call_tracking', { start: day, end: day }, {
          today: day,
          syncRunId: null,
        });
      }
      /*
       * Read-then-write inside one transaction, and the unique index is what
       * makes it safe: two concurrent deliveries cannot both insert, so the
       * loser takes the update branch and re-reads under its own lock.
       */
      const [existing] = await tx
        .select({
          id: schema.webhookDeliveries.id,
          reasons: schema.webhookDeliveries.reasons,
          senders: schema.webhookDeliveries.senders,
          samples: schema.webhookDeliveries.samples,
        })
        .from(schema.webhookDeliveries)
        .where(
          sql`${schema.webhookDeliveries.tenantId} = ${tenant.id}
              and ${schema.webhookDeliveries.source} = ${source}
              and ${schema.webhookDeliveries.day} = ${day}`,
        )
        .for('update');

      const reasons = mergeReasons(
        (existing?.reasons as Record<string, unknown>) ?? {},
        counts,
      );
      const senders = mergeSenders(
        (existing?.senders as Record<string, unknown>) ?? {},
        sender,
        { accepted, rejected, refused: outcome.kind === 'refused' ? 1 : 0 },
      );
      // The latest per sender and outcome, overwritten: at most six keys.
      const samples = { ...((existing?.samples as Record<string, unknown>) ?? {}) };
      if (outcome.sample !== undefined) samples[sampleKey] = outcome.sample;

      if (existing) {
        await tx
          .update(schema.webhookDeliveries)
          .set({
            received: sql`${schema.webhookDeliveries.received} + 1`,
            accepted: sql`${schema.webhookDeliveries.accepted} + ${inserted}`,
            rejected: sql`${schema.webhookDeliveries.rejected} + ${rejected}`,
            reasons,
            senders,
            samples,
            lastReceivedAt: now,
          })
          .where(eq(schema.webhookDeliveries.id, existing.id));
        return;
      }

      await tx.insert(schema.webhookDeliveries).values({
        tenantId: tenant.id,
        source,
        day,
        received: 1,
        accepted: inserted,
        rejected,
        reasons,
        senders,
        samples,
        firstReceivedAt: now,
        lastReceivedAt: now,
      });
    });
    return true;
  } catch (error) {
    // Best effort, loudly. A counter that cannot be written must not turn a
    // delivery we already ingested into a 500 that Aloware retries forever.
    console.error(`[webhook] could not record a ${source} delivery for ${slug}:`, error);
    return false;
  }
}
