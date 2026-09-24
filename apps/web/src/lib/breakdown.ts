import { and, eq, sql, type SQL } from 'drizzle-orm';
import { leadsCreatedIn, schema, stageEventsIn } from '@zeeraa/db';
import { queryTenant, type TenantSession } from '@/lib/tenant';

type DayRange = { start: string; end: string };

/**
 * The funnel sliced by one thing about the lead (24 September 2026):
 *
 * - **Industry** and **State**, the Salesforce Lead fields a value sweep found
 *   populated (39.1% and 35.7% of inbound leads since June). No other field
 *   holds either.
 * - **Campaign**: Google Ads by the campaign of the lead's own click, from the
 *   stored click data; Meta by the lead's UTM campaign, which 98% of Meta
 *   leads carry. A lead from neither has no campaign.
 * - **Product** is not offered: the only product field, Opportunity
 *   `csbs__Product__c`, holds `MCA` on 4.9% of deals — one value, so a slice
 *   would be one row.
 *
 * Lead-grain stages count leads created in the period; later stages count the
 * deals those leads became, by the stage's own date, like the funnel. A lead
 * with no value is its own "Not recorded" row, never dropped, so the rows sum
 * to the funnel.
 */
export type BreakdownDimension = 'campaign' | 'industry' | 'state';

export const BREAKDOWN_DIMENSIONS: { key: BreakdownDimension; label: string }[] = [
  { key: 'campaign', label: 'Campaign' },
  { key: 'industry', label: 'Industry' },
  { key: 'state', label: 'State' },
];

export type BreakdownRow = { key: string; label: string; counts: Record<string, number>; notRecorded?: boolean };

const campaignJoin = sql`
  left join ${schema.adClicks} ac on ac.tenant_id = ${schema.leads.tenantId} and ac.click_id = ${schema.leads.clickId}
  left join ${schema.campaigns} c on c.id = ac.campaign_id`;

function dimensionOf(dimension: BreakdownDimension): SQL {
  switch (dimension) {
    case 'industry':
      return sql`nullif(trim(replace(${schema.leads.industry}, '&amp;', '&')), '')`;
    case 'state':
      return sql`nullif(upper(trim(${schema.leads.state})), '')`;
    case 'campaign':
      return sql`case
        when ${schema.leads.clickIdType} = 'google_ads' and c.name is not null then c.name
        when ${schema.leads.clickIdType} = 'meta' and nullif(trim(${schema.leads.utmCampaign}), '') is not null
          then 'Meta · ' || trim(${schema.leads.utmCampaign})
        end`;
  }
}

/** Which dimensions have anything in this period; the card hides the rest. */
export async function breakdownAvailability(session: TenantSession, range: DayRange): Promise<BreakdownDimension[]> {
  const [row] = await queryTenant(session, (tx) =>
    tx.execute<{ industry: number; state: number; campaign: number }>(sql`
      select count(${dimensionOf('industry')})::int industry,
             count(${dimensionOf('state')})::int state,
             count(${dimensionOf('campaign')})::int campaign
      from ${schema.leads} ${campaignJoin}
      where ${schema.leads.tenantId} = ${session.tenant.id} and ${leadsCreatedIn(range)}`),
  );
  return BREAKDOWN_DIMENSIONS.map((d) => d.key).filter((k) => Number(row?.[k] ?? 0) > 0);
}

export async function breakdownRows(
  session: TenantSession,
  range: DayRange,
  dimension: BreakdownDimension,
  stages: { key: string; source?: string }[],
): Promise<BreakdownRow[]> {
  const dim = dimensionOf(dimension);
  const leadStages = stages.filter((s) => s.source === 'leads' || s.source === 'qualified_leads');
  const dealStages = stages.filter((s) => !leadStages.includes(s));

  const [leadRows, dealRows] = await queryTenant(session, (tx) =>
    Promise.all([
      tx.execute<{ dim: string | null; leads: number; qualified: number }>(sql`
        select ${dim} dim, count(*)::int leads,
               count(*) filter (where ${schema.leads.mqlVerdict} = 'qualified')::int qualified
        from ${schema.leads} ${campaignJoin}
        where ${schema.leads.tenantId} = ${session.tenant.id} and ${leadsCreatedIn(range)}
        group by 1`),
      tx.execute<{ dim: string | null; stage: string; n: number }>(sql`
        select ${dim} dim, ${schema.stageEvents.stage} stage,
               count(distinct ${schema.stageEvents.opportunityExternalId})::int n
        from ${schema.stageEvents}
        join ${schema.leads} on ${schema.leads.tenantId} = ${schema.stageEvents.tenantId}
          and ${schema.leads.convertedOpportunityId} = ${schema.stageEvents.opportunityExternalId}
        ${campaignJoin}
        where ${and(eq(schema.stageEvents.tenantId, session.tenant.id), stageEventsIn(range))}
        group by 1, 2`),
    ]),
  );

  const rows = new Map<string | null, Record<string, number>>();
  const at = (key: string | null) => rows.get(key) ?? rows.set(key, {}).get(key)!;
  for (const r of leadRows) {
    for (const s of leadStages) at(r.dim)[s.key] = Number(s.source === 'qualified_leads' ? r.qualified : r.leads);
  }
  for (const r of dealRows) {
    if (dealStages.some((s) => s.key === r.stage)) at(r.dim)[r.stage] = Number(r.n);
  }

  const first = stages[0]?.key ?? '';
  const named = [...rows]
    .filter(([key]) => key !== null)
    .map(([key, counts]) => ({ key: key!, label: key!, counts }))
    .sort((a, b) => (b.counts[first] ?? 0) - (a.counts[first] ?? 0) || a.label.localeCompare(b.label));

  // Past fifteen rows the table is a list nobody reads; the rest are summed
  // into one row so the columns still add up to the funnel.
  const LIMIT = 15;
  const shown: BreakdownRow[] = named.slice(0, LIMIT);
  const rest = named.slice(LIMIT);
  if (rest.length > 0) {
    const counts: Record<string, number> = {};
    for (const r of rest) for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + n;
    shown.push({ key: '__other', label: `${rest.length} more`, counts });
  }
  const missing = rows.get(null);
  if (missing) shown.push({ key: '__none', label: 'Not recorded', counts: missing, notRecorded: true });
  return shown;
}
