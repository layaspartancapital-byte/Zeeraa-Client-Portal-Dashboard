import { schema, withJobTenant, type Database } from '@zeeraa/db';
import type { SalesforceClient, SalesforceFieldMapping, SalesforceRecord } from '@zeeraa/connectors';
import { upsertOpportunityClickIds, type ClickIdRow } from './writer';
import { closeSyncRun, openSyncRun } from './sync';

/**
 * Recovers click IDs for opportunities that converted before the
 * Lead → Opportunity field mapping existed.
 *
 * Salesforce lead field mapping copies a value at the moment of conversion and
 * never retrospectively, so every opportunity converted before the mapping went
 * in holds a permanent null. Without this, attribution begins on the day the
 * mapping landed and every trend opens with an artificial step change that
 * looks like a result.
 *
 * The values are not lost: a converted Lead still carries its click ID and
 * still points at the opportunity it became. This walks that link.
 *
 * It is a sync step rather than a one-off script, and it is safe to run again:
 *
 *   - it writes through the same idempotent upsert as the live sync, keyed on
 *     (tenant, opportunity, platform, source), so a second run rewrites the
 *     same rows rather than adding more;
 *   - it writes with `source = 'lead_conversion'`, which is a different key
 *     from the mapped field's `opportunity_field`, so it can never overwrite a
 *     value the mapping produced — and where the two disagree, the mapping has
 *     a gap worth looking at;
 *   - it takes an optional watermark so a re-run can cover a window instead of
 *     the whole history.
 */
export type BackfillContext = {
  tenantId: string;
  client: SalesforceClient;
  mapping: SalesforceFieldMapping;
  /** Only leads converted at or after this point. Omit for the full history. */
  since?: Date;
  /** Cap per run, so a first pass over a large org does not run unbounded. */
  limit?: number;
};

export type BackfillResult = {
  syncRunId: string;
  leadsExamined: number;
  clickIdsRecovered: number;
  /** Converted leads that carried no click ID at all. */
  leadsWithoutClickId: number;
  platforms: Record<string, number>;
  status: 'succeeded' | 'partial';
  note?: string;
};

export async function backfillClickIdsFromConvertedLeads(
  context: BackfillContext,
): Promise<BackfillResult> {
  const clickIdFields = Object.entries(context.mapping.lead.clickIds);

  return withJobTenant(context.tenantId, async (tx) => {
    const syncRunId = await openSyncRun(tx, context.tenantId, 'backfill_click_ids', new Date());

    const result: BackfillResult = {
      syncRunId,
      leadsExamined: 0,
      clickIdsRecovered: 0,
      leadsWithoutClickId: 0,
      platforms: {},
      status: 'succeeded',
    };

    try {
      if (clickIdFields.length === 0) {
        result.status = 'partial';
        result.note =
          'No click-ID fields are mapped on Lead, so there is nothing to recover. ' +
          'This is configuration, not a failure.';
        await closeSyncRun(tx, syncRunId, 'partial', 0, null);
        return result;
      }

      const records = await context.client.query<SalesforceRecord>(
        buildBackfillQuery(clickIdFields.map(([, field]) => field), context.since, context.limit),
      );
      result.leadsExamined = records.length;

      const rows: ClickIdRow[] = [];
      for (const record of records) {
        const opportunityId = String(record.ConvertedOpportunityId ?? '').trim();
        if (!opportunityId) continue;

        let found = false;
        for (const [platform, field] of clickIdFields) {
          const value = record[field];
          if (value == null || String(value).trim() === '') continue;
          found = true;
          rows.push({
            opportunityExternalId: opportunityId,
            platform,
            clickId: String(value).trim(),
            source: 'lead_conversion',
            leadExternalId: String(record.Id),
          });
          result.platforms[platform] = (result.platforms[platform] ?? 0) + 1;
        }
        if (!found) result.leadsWithoutClickId += 1;
      }

      result.clickIdsRecovered = await upsertOpportunityClickIds(
        tx,
        context.tenantId,
        rows,
        syncRunId,
      );

      await closeSyncRun(tx, syncRunId, 'succeeded', result.clickIdsRecovered, null);
      return result;
    } catch (error) {
      await closeSyncRun(tx, syncRunId, 'failed', result.clickIdsRecovered, String(error));
      throw error;
    }
  });
}

export function buildBackfillQuery(
  clickIdFields: readonly string[],
  since?: Date,
  limit?: number,
): string {
  const fields = ['Id', 'ConvertedOpportunityId', 'ConvertedDate', ...clickIdFields];
  const conditions = ['IsConverted = true', 'ConvertedOpportunityId != null'];
  // At least one click ID present — no point paging through leads that carry none.
  conditions.push(`(${clickIdFields.map((f) => `${f} != null`).join(' OR ')})`);
  // `ConvertedDate` is a Date, not a DateTime, so the literal has to be a bare
  // `YYYY-MM-DD` — a full ISO timestamp is rejected as malformed SOQL with a
  // 400, which is why this only ever failed when a caller passed `since`. The
  // hourly incremental passes it on every run, so it failed every run.
  //
  // Truncating to the day widens the window by up to 24 hours. That is the safe
  // direction: the upsert is idempotent, and a narrower window would miss
  // conversions recorded earlier on the same day.
  if (since) conditions.push(`ConvertedDate >= ${since.toISOString().slice(0, 10)}`);

  return (
    `SELECT ${fields.join(', ')} FROM Lead WHERE ${conditions.join(' AND ')} ` +
    `ORDER BY ConvertedDate ASC${limit ? ` LIMIT ${limit}` : ''}`
  );
}

/**
 * Where the backfill and the live mapping disagree.
 *
 * Both routes write to the same table under different `source` values, so once
 * the mapping is live this comparison is free — and a disagreement means the
 * mapping is dropping values for some conversion path, which is exactly the
 * kind of gap that otherwise shows up months later as unexplained unattributed
 * spend.
 */
export async function clickIdDisagreements(
  tx: Database,
  tenantId: string,
): Promise<{ opportunityExternalId: string; platform: string; field: string; conversion: string }[]> {
  const rows = await tx
    .select({
      opportunityExternalId: schema.opportunityClickIds.opportunityExternalId,
      platform: schema.opportunityClickIds.platform,
      source: schema.opportunityClickIds.source,
      clickId: schema.opportunityClickIds.clickId,
    })
    .from(schema.opportunityClickIds);

  const byKey = new Map<string, { opportunity_field?: string; lead_conversion?: string }>();
  for (const row of rows) {
    const key = `${row.opportunityExternalId}::${row.platform}`;
    const entry = byKey.get(key) ?? {};
    entry[row.source] = row.clickId;
    byKey.set(key, entry);
  }

  const disagreements: {
    opportunityExternalId: string;
    platform: string;
    field: string;
    conversion: string;
  }[] = [];
  for (const [key, entry] of byKey) {
    if (!entry.opportunity_field || !entry.lead_conversion) continue;
    if (entry.opportunity_field === entry.lead_conversion) continue;
    const [opportunityExternalId, platform] = key.split('::');
    disagreements.push({
      opportunityExternalId: opportunityExternalId!,
      platform: platform!,
      field: entry.opportunity_field,
      conversion: entry.lead_conversion,
    });
  }
  return disagreements;
}
