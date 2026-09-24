import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { isMonthKey, parseWallClock } from '@zeeraa/core';
import { schema, type Database } from '@zeeraa/db';
import { leadSourceExclusion, type LeadExclusionConfig } from '@zeeraa/connectors';

/**
 * Two rules applied to `stage_events` after every sync writes them.
 *
 * Both are configuration, both are idempotent, and both run as SQL over the
 * whole table rather than over the records this run fetched. That is the
 * point: the sync is incremental on Opportunity but reads field history
 * unbounded, so a stage event can be (re)written for a deal this run never
 * fetched — and a rule applied only to the fetched records would leave that
 * event unjudged.
 */

/* ------------------------------------------------------------------------- */
/* Exclusions                                                                */
/* ------------------------------------------------------------------------- */

/**
 * A real event that must not be counted.
 *
 * The one live instance: a renewal reaching Funded is a deal, but not a deal
 * marketing produced, and counting it would lower every cost per funded deal
 * by a deal the spend did not buy. Matched on `opportunities.deal_type`,
 * case-insensitively and trimmed, because the CRM holds `Renewal` and
 * `Renewals` side by side and a picklist edit should not silently reopen the
 * door.
 */
export type StageExclusionRule = {
  /** Written to `excluded_reason`. */
  reason: string;
  /** `opportunities.deal_type` values that trigger the rule. */
  dealTypes: string[];
  /**
   * Stage keys the rule applies to, or `['*']` for every stage — which also
   * excludes any lead that converted into a matching deal, because Lead and
   * MQL are counted from `leads`, not from stage events. Renewals use `*`:
   * they are not marketing's at any stage.
   */
  stages: string[];
};

/** A rule that reaches every stage, including the lead-grain ones. */
export function coversEveryStage(rule: StageExclusionRule): boolean {
  return rule.stages.includes('*');
}

export function parseStageExclusions(value: unknown): StageExclusionRule[] {
  if (value == null) return [];
  const rules = (value as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    throw new Error('stage_exclusions must be { rules: [...] }.');
  }
  return rules.map((raw, i) => {
    const r = raw as Partial<StageExclusionRule>;
    const strings = (v: unknown) =>
      Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '');
    if (typeof r.reason !== 'string' || r.reason.trim() === '' || !strings(r.dealTypes) || !strings(r.stages)) {
      throw new Error(
        `stage_exclusions rule ${i} needs a reason and non-empty dealTypes and stages. ` +
          'A malformed rule is refused rather than read as "exclude nothing".',
      );
    }
    return { reason: r.reason, dealTypes: r.dealTypes!, stages: r.stages! };
  });
}

/**
 * Recomputes `excluded_reason` for the whole tenant.
 *
 * Cleared first, then applied rule by rule, so removing a rule from config
 * restores the events it had excluded on the next sync. Inside the sync's
 * transaction, so no reader sees the cleared state.
 */
export async function applyStageExclusions(
  tx: Database,
  tenantId: string,
  rules: readonly StageExclusionRule[],
): Promise<Record<string, number>> {
  await tx
    .update(schema.stageEvents)
    .set({ excludedReason: null })
    .where(
      and(
        eq(schema.stageEvents.tenantId, tenantId),
        sql`${schema.stageEvents.excludedReason} is not null`,
      ),
    );
  await tx
    .update(schema.leads)
    .set({ excludedReason: null })
    .where(and(eq(schema.leads.tenantId, tenantId), sql`${schema.leads.excludedReason} is not null`));
  await tx
    .update(schema.submissions)
    .set({ excludedReason: null })
    .where(
      and(eq(schema.submissions.tenantId, tenantId), sql`${schema.submissions.excludedReason} is not null`),
    );

  const counts: Record<string, number> = {};
  for (const rule of rules) {
    const types = sql.join(
      rule.dealTypes.map((t) => sql`${t.trim().toLowerCase()}`),
      sql`, `,
    );
    const updated = await tx
      .update(schema.stageEvents)
      .set({ excludedReason: rule.reason })
      .where(
        and(
          eq(schema.stageEvents.tenantId, tenantId),
          ...(coversEveryStage(rule) ? [] : [inArray(schema.stageEvents.stage, rule.stages)]),
          sql`exists (
            select 1 from ${schema.opportunities} o
            where o.tenant_id = ${schema.stageEvents.tenantId}
              and o.external_id = ${schema.stageEvents.opportunityExternalId}
              and lower(trim(o.deal_type)) in (${types})
          )`,
        ),
      )
      .returning({ id: schema.stageEvents.id });
    counts[rule.reason] = (counts[rule.reason] ?? 0) + updated.length;

    if (coversEveryStage(rule)) {
      const leads = await tx
        .update(schema.leads)
        .set({ excludedReason: rule.reason })
        .where(
          and(
            eq(schema.leads.tenantId, tenantId),
            sql`exists (
              select 1 from ${schema.opportunities} o
              where o.tenant_id = ${schema.leads.tenantId}
                and o.external_id = ${schema.leads.convertedOpportunityId}
                and lower(trim(o.deal_type)) in (${types})
            )`,
          ),
        )
        .returning({ id: schema.leads.id });
      counts[`${rule.reason}:leads`] = (counts[`${rule.reason}:leads`] ?? 0) + leads.length;

      // A deal excluded at every stage is excluded from the lenders' view of
      // it too: its submissions are not in any offer rate.
      const submissions = await tx
        .update(schema.submissions)
        .set({ excludedReason: rule.reason })
        .where(
          and(
            eq(schema.submissions.tenantId, tenantId),
            sql`exists (
              select 1 from ${schema.opportunities} o
              where o.tenant_id = ${schema.submissions.tenantId}
                and o.external_id = ${schema.submissions.opportunityExternalId}
                and lower(trim(o.deal_type)) in (${types})
            )`,
          ),
        )
        .returning({ id: schema.submissions.id });
      counts[`${rule.reason}:submissions`] =
        (counts[`${rule.reason}:submissions`] ?? 0) + submissions.length;
    }
  }

  /*
   * A lead merged into another is the same merchant counted twice. Salesforce
   * keeps the loser only in the recycle bin; we keep it, marked, so its click
   * id can move to the survivor — and until 23 September 2026 we also kept
   * counting it: 45 of September's leads were merged duplicates. Not a config
   * rule, because a merge is never a lead in its own right for any client.
   * Applied after the rules and only where no rule claimed the lead, so the
   * reason a lead is excluded is the most specific one.
   */
  const merged = await tx
    .update(schema.leads)
    .set({ excludedReason: 'merged' })
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        sql`${schema.leads.mergedInto} is not null`,
        sql`${schema.leads.excludedReason} is null`,
      ),
    )
    .returning({ id: schema.leads.id });
  counts['merged:leads'] = merged.length;
  return counts;
}

/* ------------------------------------------------------------------------- */
/* Corrections                                                               */
/* ------------------------------------------------------------------------- */

/**
 * A stage date a person has corrected over what the CRM records.
 *
 * Only a month, deliberately. The live instance is a deal funded in May whose
 * rep could not move it to Funded until they backfilled a submission, an offer
 * and a contract on 1 September — every date on the record is either that
 * backfill or a copy of the creation date, so the day is unknowable and the
 * month is what the evidence supports. The event is written at the first
 * instant of the month with `occurred_precision = 'month'`, which says nothing
 * may compute a duration from it.
 */
export type StageCorrection = {
  opportunity: string;
  stage: string;
  /** `YYYY-MM`, tenant-local. */
  month: string;
  /** Who said so, when, and on what evidence. Rendered with the correction. */
  source: string;
};

export function parseStageCorrections(value: unknown): StageCorrection[] {
  if (value == null) return [];
  const list = (value as { corrections?: unknown }).corrections;
  if (!Array.isArray(list)) throw new Error('stage_corrections must be { corrections: [...] }.');
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const c = raw as Partial<StageCorrection>;
    if (
      typeof c.opportunity !== 'string' ||
      typeof c.stage !== 'string' ||
      typeof c.month !== 'string' ||
      !isMonthKey(c.month) ||
      typeof c.source !== 'string' ||
      c.source.trim() === ''
    ) {
      throw new Error(
        `stage_corrections entry ${i} needs opportunity, stage, a YYYY-MM month and a source. ` +
          'A correction with no source is an unexplained number, and is refused.',
      );
    }
    const key = `${c.opportunity}|${c.stage}`;
    if (seen.has(key)) throw new Error(`stage_corrections corrects ${key} twice.`);
    seen.add(key);
    return { opportunity: c.opportunity, stage: c.stage, month: c.month, source: c.source };
  });
}

/**
 * Replaces the CRM's events for each corrected (deal, stage) with the
 * correction.
 *
 * Observed and computed rows for the pair are deleted — the sync writes them
 * back whenever the deal is modified, which is why this runs after every sync
 * rather than once. A corrected row no longer in config is deleted too; the
 * CRM's own event returns the next time that deal is fully re-read.
 */
export async function applyStageCorrections(
  tx: Database,
  tenantId: string,
  corrections: readonly StageCorrection[],
): Promise<number> {
  const [tenant] = await tx
    .select({ timezone: schema.tenants.timezone })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId));
  if (!tenant) throw new Error(`Tenant ${tenantId} is not visible to this transaction.`);

  const keep = corrections.map((c) => `${c.opportunity}|${c.stage}`);
  await tx
    .delete(schema.stageEvents)
    .where(
      and(
        eq(schema.stageEvents.tenantId, tenantId),
        eq(schema.stageEvents.origin, 'corrected'),
        ...(keep.length > 0
          ? [
              notInArray(
                sql`${schema.stageEvents.opportunityExternalId} || '|' || ${schema.stageEvents.stage}`,
                keep,
              ),
            ]
          : []),
      ),
    );

  for (const c of corrections) {
    const occurredAt = parseWallClock(`${c.month}-01 00:00:00`, tenant.timezone);
    if (!occurredAt) throw new Error(`Cannot place ${c.month} in ${tenant.timezone}.`);

    await tx
      .delete(schema.stageEvents)
      .where(
        and(
          eq(schema.stageEvents.tenantId, tenantId),
          eq(schema.stageEvents.opportunityExternalId, c.opportunity),
          eq(schema.stageEvents.stage, c.stage),
          sql`(${schema.stageEvents.origin} <> 'corrected' or ${schema.stageEvents.occurredAt} <> ${occurredAt.toISOString()}::timestamptz)`,
        ),
      );

    await tx
      .insert(schema.stageEvents)
      .values({
        tenantId,
        opportunityExternalId: c.opportunity,
        stage: c.stage,
        occurredAt,
        occurredOn: `${c.month}-01`,
        occurredPrecision: 'month',
        origin: 'corrected',
        correctionSource: c.source,
      })
      .onConflictDoUpdate({
        target: [
          schema.stageEvents.tenantId,
          schema.stageEvents.opportunityExternalId,
          schema.stageEvents.stage,
          schema.stageEvents.occurredAt,
        ],
        set: {
          occurredOn: sql`excluded.occurred_on`,
          occurredPrecision: sql`excluded.occurred_precision`,
          origin: sql`excluded.origin`,
          correctionSource: sql`excluded.correction_source`,
        },
      });
  }

  // Nothing but the correction survives for a corrected pair.
  if (corrections.length > 0) {
    const stray = await tx
      .select({ id: schema.stageEvents.id })
      .from(schema.stageEvents)
      .where(
        and(
          eq(schema.stageEvents.tenantId, tenantId),
          ne(schema.stageEvents.origin, 'corrected'),
          inArray(
            sql`${schema.stageEvents.opportunityExternalId} || '|' || ${schema.stageEvents.stage}`,
            keep,
          ),
        ),
      );
    if (stray.length > 0) throw new Error('A corrected stage still holds a CRM event.');
  }

  return corrections.length;
}

/**
 * Lenders whose submissions are real records and not lending: a CRM's test
 * accounts (24 September 2026). The `lender_exclusions` config row:
 * `{ reason, lenders: [{ id, name }] }`, matched on the lender's Salesforce id,
 * which survives a rename. Their submissions carry `excluded_reason`, so
 * `submissionsIn` drops them from every lender table, rate and total.
 *
 * Applied after the submissions upsert on every sync, and after
 * `applyStageExclusions` has cleared the column, so it holds however often the
 * sync runs. Throws on a malformed row, like the other rules: a rule that
 * parsed to nothing would put the test lender back in the totals silently.
 */
export type LenderExclusion = { reason: string; lenderIds: string[] };

export function parseLenderExclusions(value: unknown): LenderExclusion | null {
  if (value == null) return null;
  const v = value as { reason?: unknown; lenders?: unknown };
  if (typeof v.reason !== 'string' || !v.reason || !Array.isArray(v.lenders) || v.lenders.length === 0) {
    throw new Error('lender_exclusions must be { reason, lenders: [{ id, name }, ...] }.');
  }
  const lenderIds = v.lenders.map((l, i) => {
    const id = (l as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) throw new Error(`lender_exclusions lender ${i} needs an id.`);
    return id;
  });
  return { reason: v.reason, lenderIds };
}

export async function applyLenderExclusions(
  tx: Database,
  tenantId: string,
  rule: LenderExclusion | null,
): Promise<number> {
  if (!rule) return 0;
  const updated = await tx
    .update(schema.submissions)
    .set({ excludedReason: rule.reason })
    .where(
      and(
        eq(schema.submissions.tenantId, tenantId),
        inArray(schema.submissions.lenderExternalId, rule.lenderIds),
        sql`${schema.submissions.excludedReason} is null`,
      ),
    )
    .returning({ id: schema.submissions.id });
  return updated.length;
}

/**
 * Leads a Lead Source exclusion covers (ZoomInfo, outbound), marked excluded.
 *
 * Run after `applyStageExclusions`, which clears every lead's
 * `excluded_reason` before re-applying the renewal rules — without this the
 * next sync would put the outbound leads back into every count (it did, on
 * 24 September 2026, within ten minutes of the backfill). The sync never reads
 * these leads again, so the stored ones are marked here from their stored
 * Lead Source. Only a rule whose sole criterion is `leadSources` applies.
 */
export async function applyLeadSourceExclusions(
  tx: Database,
  tenantId: string,
  exclusion: LeadExclusionConfig,
): Promise<number> {
  if (!exclusion.enabled) return 0;
  let marked = 0;
  for (const rule of exclusion.rules) {
    if (!rule.leadSources?.length) continue;
    if (leadSourceExclusion(exclusion, rule.leadSources[0]!)?.key !== rule.key) continue;
    const rows = await tx
      .update(schema.leads)
      .set({ excludedReason: rule.key })
      .where(
        and(
          eq(schema.leads.tenantId, tenantId),
          inArray(schema.leads.leadSource, rule.leadSources),
          sql`${schema.leads.excludedReason} is null`,
        ),
      )
      .returning({ id: schema.leads.id });
    marked += rows.length;
  }
  return marked;
}
