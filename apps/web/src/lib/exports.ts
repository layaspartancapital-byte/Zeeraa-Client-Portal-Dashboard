import 'server-only';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import { callsIn, countedStageEvent, leadChannel, leadsCreatedIn, schema, stageEventsIn, submissionsIn } from '@zeeraa/db';
import {
  platformLabel,
  stageBeforeValue,
  trailingMonths,
  type AttributionModel,
  type DateRange,
  type StageDefinition,
} from '@zeeraa/core';
import type { ExportAuditDetail } from '@zeeraa/db/schema';
import { queryTenant, type TenantSession } from '@/lib/tenant';
import type { XlsxCell, XlsxColumn, XlsxSheet } from '@/lib/xlsx';
import { buildRampPanels, RAMP_TABLE_COLUMNS, rampTableRows } from '@/lib/ramp-panels';
import * as cached from '@/lib/cached-reports';
import { comparisonReport } from '@/lib/comparison';

/**
 * The Excel exports (30 October 2026): the rows behind each card, for the
 * page's range, attribution model and source, as typed sheets.
 *
 * **Contact columns** — name, email, phone, company, owner — are added only
 * for a Zeeraa admin or a client admin (`seesContacts`), and are read from
 * `crm_contacts`, whose policy admits those two roles and nobody else: a
 * viewer's export leaves the columns out, and even a bug that asked for them
 * would read nothing. Nothing else personal is exported: no SSN, date of
 * birth, bank or credit field exists to be read.
 *
 * Every query runs through `queryTenant`, under the viewer's own row level
 * security, like the page the export was taken from.
 */

export const DATASETS = [
  'deals',
  'leads',
  'lender_decisions',
  'calls',
  'sources',
  'ramp',
  'campaigns',
  'platform_daily',
  'seo',
  'organic',
  'comparison',
] as const;
export type Dataset = (typeof DATASETS)[number];

export const PAGES = ['executive', 'performance', 'funnel', 'platform', 'comparison'] as const;
export type ExportPage = (typeof PAGES)[number];

/** What one card's button asks for. `stage` narrows deals or leads; `platform` names a platform page's source. */
export type ExportSpec = { dataset: Dataset; stage?: string; platform?: string };

export type ExportFilters = {
  range: DateRange;
  model: AttributionModel;
  /** A channel key (`google_ads`, `vendor:Popcrumbs`, `unattributed`), or null for every source. */
  source: string | null;
  today: string;
  /** Comparison's Period B; Period A is `range`. */
  compare?: DateRange | null;
};

export function seesContacts(role: string): boolean {
  return role === 'zeeraa_admin' || role === 'client_admin';
}

/** The datasets behind every card on a page, for "Export everything". */
export function pageExports(page: ExportPage, platform: string | null, kind: string | null): ExportSpec[] {
  switch (page) {
    case 'executive':
      return [{ dataset: 'sources' }, { dataset: 'deals', stage: 'value' }, { dataset: 'deals' }, { dataset: 'leads' }, { dataset: 'ramp' }];
    case 'performance':
      return [{ dataset: 'sources' }, { dataset: 'ramp' }, { dataset: 'deals' }, { dataset: 'leads' }, { dataset: 'lender_decisions' }];
    case 'funnel':
      return [{ dataset: 'leads' }, { dataset: 'deals' }, { dataset: 'lender_decisions' }, { dataset: 'calls' }];
    case 'comparison':
      return [{ dataset: 'comparison' }];
    case 'platform':
      if (!platform) return [];
      if (kind === 'seo') return [{ dataset: 'seo', platform }];
      if (kind === 'organic') return [{ dataset: 'organic', platform }];
      return [
        { dataset: 'campaigns', platform },
        { dataset: 'platform_daily', platform },
        { dataset: 'deals', stage: 'value', platform },
        { dataset: 'leads', platform },
      ];
  }
}

type Ctx = { session: TenantSession; filters: ExportFilters; contacts: boolean };

type Stage = StageDefinition & { label: string; source: string | null };

async function funnelStages(session: TenantSession): Promise<Stage[]> {
  return queryTenant(session, (tx) =>
    tx
      .select({
        key: schema.funnelStages.key,
        label: schema.funnelStages.label,
        position: schema.funnelStages.position,
        countsValue: schema.funnelStages.countsValue,
        isOptimizationTarget: schema.funnelStages.isOptimizationTarget,
        source: schema.funnelStages.source,
      })
      .from(schema.funnelStages)
      .where(eq(schema.funnelStages.tenantId, session.tenant.id))
      .orderBy(asc(schema.funnelStages.position)),
  );
}

const CONTACT_COLUMNS: XlsxColumn[] = [
  { header: 'Contact name', type: 'text' },
  { header: 'Email', type: 'text' },
  { header: 'Phone', type: 'text' },
  { header: 'Company', type: 'text' },
  { header: 'Owner', type: 'text' },
];

const sourceLabel = (channel: string | null) => (channel ? platformLabel(channel) : 'Direct & other');

/** A deal's or lead's source against the filter: `unattributed` is Direct & other. */
function sourceFilter(column: SQL, source: string | null): SQL {
  if (!source) return sql`true`;
  if (source === 'unattributed') return sql`${column} is null`;
  return sql`${column} = ${source}`;
}

/* ------------------------------------------------------------------------- */
/* Deals                                                                     */
/* ------------------------------------------------------------------------- */

type DealRow = {
  id: string;
  name: string | null;
  status: string;
  created: string;
  is_closed: boolean | null;
  max_offer: string | null;
  funded_amount: string | null;
  decline_reason: string | null;
  source: string | null;
  campaign: string | null;
  utm_campaign: string | null;
  keyword: string | null;
  dates: Record<string, string> | null;
  declined_by_lender: boolean | null;
  lender_reasons: string | null;
  last_lender_reason: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  owner: string | null;
};

type DecisionRow = {
  deal: string;
  deal_name: string | null;
  source: string | null;
  lender: string | null;
  outcome: string;
  decided_at: string;
  reasons: string | null;
  status: string | null;
};

/** The deals reaching `stage` (any stage, if none) in the range, one row each. */
async function dealRows(ctx: Ctx, stage: string | null, platform: string | null) {
  const { session, filters } = ctx;
  const t = session.tenant.id;
  const se = schema.stageEvents;
  const source = platform ?? filters.source;
  return queryTenant(session, async (tx) => {
    const rows = await tx.execute<DealRow>(sql`
      with picked as (
        select distinct ${se.opportunityExternalId} as id from ${se}
        where ${se.tenantId} = ${t} and ${stageEventsIn(filters.range)}
          ${stage ? sql`and ${se.stage} = ${stage}` : sql``}
      ),
      first_lead as (
        select distinct on (l.converted_opportunity_id)
          l.converted_opportunity_id as opp, l.external_id, l.utm_campaign, l.utm_term
        from ${schema.leads} l
        where l.tenant_id = ${t} and l.converted_opportunity_id in (select id from picked)
        order by l.converted_opportunity_id, l.excluded_reason is not null, l.created_at
      ),
      dates as (
        select id, jsonb_object_agg(stage, first_on) as dates from (
          select ${se.opportunityExternalId} as id, ${se.stage} as stage, min(${se.occurredOn})::text as first_on
          from ${se}
          where ${se.tenantId} = ${t} and ${countedStageEvent()} and ${se.opportunityExternalId} in (select id from picked)
          group by 1, 2
        ) x group by 1
      ),
      lenders as (
        select s.opportunity_external_id as id,
          bool_or(s.outcome = 'declined') as declined_by_lender,
          string_agg(
            case when s.outcome = 'declined' then coalesce(s.lender_name, 'Unknown lender') || ': ' ||
              coalesce(nullif(array_to_string(s.decline_reasons, ', '), ''), 'No reason given') end,
            '; ' order by coalesce(s.status_changed_at, s.submitted_at)) as lender_reasons,
          (array_agg(coalesce(nullif(array_to_string(s.decline_reasons, ', '), ''), 'No reason given')
             order by coalesce(s.status_changed_at, s.submitted_at) desc)
             filter (where s.outcome = 'declined'))[1] as last_lender_reason
        from ${schema.submissions} s
        where s.tenant_id = ${t} and s.opportunity_external_id in (select id from picked)
        group by 1
      )
      select o.external_id as id, o.name, o.current_stage as status, o.created_at::text as created, o.is_closed,
        o.max_offer_amount::text as max_offer, o.funded_amount::text as funded_amount, o.decline_reason,
        a.platform as source, c.name as campaign, fl.utm_campaign, fl.utm_term as keyword, d.dates,
        ln.declined_by_lender, ln.lender_reasons, ln.last_lender_reason,
        lc.name as contact_name, lc.email, lc.phone,
        coalesce(oc.company, lc.company) as company, coalesce(oc.owner_name, lc.owner_name) as owner
      from picked
      join ${schema.opportunities} o on o.tenant_id = ${t} and o.external_id = picked.id
      left join ${schema.attribution} a on a.tenant_id = ${t} and a.opportunity_external_id = o.external_id
        and a.model = ${filters.model}
      left join ${schema.campaigns} c on c.id = a.campaign_id
      left join first_lead fl on fl.opp = o.external_id
      left join dates d on d.id = o.external_id
      left join lenders ln on ln.id = o.external_id
      ${ctx.contacts
        ? sql`left join ${schema.crmContacts} lc on lc.tenant_id = ${t} and lc.object = 'lead' and lc.external_id = fl.external_id
              left join ${schema.crmContacts} oc on oc.tenant_id = ${t} and oc.object = 'opportunity' and oc.external_id = o.external_id`
        : sql`left join (select null::text as name, null::text as email, null::text as phone, null::text as company, null::text as owner_name) lc on false
              left join (select null::text as company, null::text as owner_name) oc on false`}
      where ${sourceFilter(sql`a.platform`, source)}
      order by o.created_at`);
    return [...rows];
  });
}

async function decisionRows(ctx: Ctx, dealIds: string[] | null, platform: string | null) {
  const { session, filters } = ctx;
  const t = session.tenant.id;
  const source = platform ?? filters.source;
  return queryTenant(session, async (tx) => {
    const sub = schema.submissions;
    const rows = await tx.execute<DecisionRow>(sql`
      select ${sub.opportunityExternalId} as deal, o.name as deal_name, a.platform as source, ${sub.lenderName} as lender,
        ${sub.outcome}::text as outcome, coalesce(${sub.statusChangedAt}, ${sub.submittedAt})::text as decided_at,
        nullif(array_to_string(${sub.declineReasons}, ', '), '') as reasons, ${sub.status} as status
      from ${sub}
      left join ${schema.opportunities} o on o.tenant_id = ${t} and o.external_id = ${sub.opportunityExternalId}
      left join ${schema.attribution} a on a.tenant_id = ${t} and a.opportunity_external_id = ${sub.opportunityExternalId}
        and a.model = ${filters.model}
      where ${sub.tenantId} = ${t} and ${sub.outcome} in ('offered', 'declined')
        and ${dealIds
          ? dealIds.length === 0
            ? sql`false`
            : sql`${sub.opportunityExternalId} in (${sql.join(dealIds.map((id) => sql`${id}`), sql`, `)})`
          : sql`${submissionsIn(filters.range)} and ${sourceFilter(sql`a.platform`, source)}`}
      order by ${sub.opportunityExternalId}, coalesce(${sub.statusChangedAt}, ${sub.submittedAt})`);
    return [...rows];
  });
}

function decisionSheet(rows: DecisionRow[], name = 'Lender decisions'): XlsxSheet {
  return {
    name,
    columns: [
      { header: 'Deal ID', type: 'text' },
      { header: 'Deal name', type: 'text' },
      { header: 'Source', type: 'text' },
      { header: 'Lender', type: 'text' },
      { header: 'Decision', type: 'text' },
      { header: 'Date', type: 'datetime' },
      { header: 'Decline reason', type: 'text' },
      { header: 'Lender status', type: 'text' },
    ],
    rows: rows.map((r) => [
      r.deal,
      r.deal_name,
      sourceLabel(r.source),
      r.lender ?? 'Unknown lender',
      r.outcome === 'declined' ? 'Declined' : 'Offered',
      r.decided_at ? new Date(r.decided_at) : null,
      r.outcome === 'declined' ? (r.reasons ?? 'No reason given') : null,
      r.status,
    ]),
  };
}

async function dealSheets(ctx: Ctx, stageParam: string | null, platform: string | null): Promise<XlsxSheet[]> {
  const stages = await funnelStages(ctx.session);
  const value = stages.find((s) => s.countsValue) ?? null;
  const approval = stageBeforeValue(stages);
  const stage = stageParam === 'value' ? (value?.key ?? null) : stageParam;
  const eventStages = stages.filter((s) => (s.source ?? 'stage_events') === 'stage_events');
  const rows = await dealRows(ctx, stage, platform);
  const decisions = await decisionRows(ctx, rows.map((r) => r.id), platform);
  const label = stage ? (stages.find((s) => s.key === stage)?.label ?? stage.charAt(0).toUpperCase() + stage.slice(1)) : 'All';

  const columns: XlsxColumn[] = [
    { header: 'Deal ID', type: 'text' },
    { header: 'Deal name', type: 'text' },
    { header: 'Status', type: 'text' },
    { header: 'Source', type: 'text' },
    { header: 'Campaign', type: 'text' },
    { header: 'Keyword (UTM term)', type: 'text' },
    { header: 'Created', type: 'date' },
    ...eventStages.map((s): XlsxColumn => ({ header: `${s.label} date`, type: 'date' })),
    { header: 'Approved', type: 'boolean' },
    { header: 'Approved amount', type: 'money' },
    { header: `${value?.label ?? 'Funded'} amount`, type: 'money' },
    { header: 'Declined by a lender', type: 'boolean' },
    { header: 'Lender decline reasons', type: 'text' },
    { header: 'Declined in the end', type: 'boolean' },
    { header: 'Final reason', type: 'text' },
    ...(ctx.contacts ? CONTACT_COLUMNS : []),
  ];
  const sheetRows = rows.map((r): XlsxCell[] => {
    const dates = r.dates ?? {};
    const reachedValue = value ? Boolean(dates[value.key]) : false;
    const declinedInEnd = r.is_closed === true && !reachedValue;
    return [
      r.id,
      r.name,
      r.status,
      sourceLabel(r.source),
      r.campaign ?? r.utm_campaign,
      r.keyword,
      r.created?.slice(0, 10) ?? null,
      ...eventStages.map((s) => dates[s.key] ?? null),
      approval ? Boolean(dates[approval.key]) : null,
      r.max_offer === null ? null : Number(r.max_offer),
      reachedValue && r.funded_amount !== null ? Number(r.funded_amount) : null,
      r.declined_by_lender === true,
      r.lender_reasons,
      declinedInEnd,
      declinedInEnd ? (r.decline_reason ?? r.last_lender_reason ?? r.status) : null,
      ...(ctx.contacts ? [r.contact_name, r.email, r.phone, r.company, r.owner] : []),
    ];
  });
  return [
    { name: `Deals · ${label}`, columns, rows: sheetRows },
    decisionSheet(decisions, stage ? `Lender decisions · ${label}` : 'Lender decisions · all deals'),
  ];
}

/* ------------------------------------------------------------------------- */
/* Leads and calls                                                           */
/* ------------------------------------------------------------------------- */

async function leadSheets(ctx: Ctx, stage: string | null, platform: string | null): Promise<XlsxSheet[]> {
  const { session, filters } = ctx;
  const t = session.tenant.id;
  const l = schema.leads;
  const source = platform ?? filters.source;
  const stages = await funnelStages(session);
  const qualifiedOnly = stage ? stages.find((s) => s.key === stage)?.source === 'qualified_leads' : false;
  const rows = await queryTenant(session, async (tx) => [
    ...(await tx.execute<{
      id: string;
      created: string;
      channel: string | null;
      lead_source: string | null;
      campaign: string | null;
      utm_campaign: string | null;
      keyword: string | null;
      verdict: string | null;
      band: string | null;
      industry: string | null;
      state: string | null;
      deal: string | null;
      deal_stage: string | null;
      name: string | null;
      email: string | null;
      phone: string | null;
      company: string | null;
      owner: string | null;
    }>(sql`
      select ${l.externalId} as id, ${l.createdOn}::text as created, ${leadChannel()} as channel,
        ${l.leadSource} as lead_source, c.name as campaign, ${l.utmCampaign} as utm_campaign, ${l.utmTerm} as keyword,
        ${l.mqlVerdict}::text as verdict, ${l.revenueBand} as band, ${l.industry} as industry, ${l.state} as state,
        ${l.convertedOpportunityId} as deal, o.current_stage as deal_stage,
        ${ctx.contacts ? sql`k.name, k.email, k.phone, k.company, k.owner_name as owner` : sql`null::text as name, null::text as email, null::text as phone, null::text as company, null::text as owner`}
      from ${l}
      left join ${schema.adClicks} ac on ac.tenant_id = ${l.tenantId} and ac.click_id = ${l.clickId}
      left join ${schema.campaigns} c on c.id = ac.campaign_id
      left join ${schema.opportunities} o on o.tenant_id = ${l.tenantId} and o.external_id = ${l.convertedOpportunityId}
      ${ctx.contacts ? sql`left join ${schema.crmContacts} k on k.tenant_id = ${l.tenantId} and k.object = 'lead' and k.external_id = ${l.externalId}` : sql``}
      where ${l.tenantId} = ${t} and ${leadsCreatedIn(filters.range)}
        ${qualifiedOnly ? sql`and ${l.mqlVerdict} = 'qualified'` : sql``}
        and ${sourceFilter(leadChannel(), source)}
      order by ${l.createdOn}, ${l.externalId}`)),
  ]);
  const verdict: Record<string, string> = {
    qualified: 'MQL',
    unqualified: 'Not qualified',
    undeterminable: 'Undeterminable',
  };
  return [
    {
      name: qualifiedOnly ? 'MQLs' : 'Leads',
      columns: [
        { header: 'Lead ID', type: 'text' },
        { header: 'Created', type: 'date' },
        { header: 'Source', type: 'text' },
        { header: 'Lead source (CRM)', type: 'text' },
        { header: 'Campaign', type: 'text' },
        { header: 'Keyword (UTM term)', type: 'text' },
        { header: 'Stage', type: 'text' },
        { header: 'Revenue band', type: 'text' },
        { header: 'Industry', type: 'text' },
        { header: 'State', type: 'text' },
        { header: 'Deal ID', type: 'text' },
        { header: 'Deal status', type: 'text' },
        ...(ctx.contacts ? CONTACT_COLUMNS : []),
      ],
      rows: rows.map((r) => [
        r.id,
        r.created,
        sourceLabel(r.channel),
        r.lead_source,
        r.campaign ?? r.utm_campaign,
        r.keyword,
        r.deal ? 'Converted to a deal' : (verdict[r.verdict ?? ''] ?? 'Lead'),
        r.band,
        r.industry,
        r.state,
        r.deal,
        r.deal_stage,
        ...(ctx.contacts ? [r.name, r.email, r.phone, r.company, r.owner] : []),
      ]),
    },
  ];
}

async function callSheets(ctx: Ctx): Promise<XlsxSheet[]> {
  const { session, filters } = ctx;
  const t = session.tenant.id;
  const c = schema.calls;
  const rows = await queryTenant(session, async (tx) => [
    ...(await tx.execute<{
      at: string;
      direction: string;
      outcome: string;
      disposition: string | null;
      talk: string | null;
      duration: string | null;
      lead: string | null;
      channel: string | null;
      number: string | null;
      agent: string | null;
      name: string | null;
    }>(sql`
      select ${c.occurredAt}::text as at, ${c.direction}::text as direction, ${c.outcome}::text as outcome,
        ${c.disposition} as disposition, ${c.talkTimeSeconds}::text as talk, ${c.durationSeconds}::text as duration,
        ${c.leadExternalId} as lead, coalesce(l.channel, l.click_id_type) as channel,
        ${ctx.contacts ? sql`${c.contactNumber} as number, ${c.agentName} as agent, k.name` : sql`null::text as number, null::text as agent, null::text as name`}
      from ${c}
      left join ${schema.leads} l on l.tenant_id = ${c.tenantId} and l.external_id = ${c.leadExternalId}
      ${ctx.contacts ? sql`left join ${schema.crmContacts} k on k.tenant_id = ${c.tenantId} and k.object = 'lead' and k.external_id = ${c.leadExternalId}` : sql``}
      where ${c.tenantId} = ${t} and ${callsIn(filters.range)}
        and ${sourceFilter(sql`coalesce(l.channel, l.click_id_type)`, filters.source)}
      order by ${c.occurredAt}`)),
  ]);
  return [
    {
      name: 'Calls',
      columns: [
        { header: 'Called at', type: 'datetime' },
        { header: 'Direction', type: 'text' },
        { header: 'Outcome', type: 'text' },
        { header: 'Disposition', type: 'text' },
        { header: 'Talk time (s)', type: 'count' },
        { header: 'Duration (s)', type: 'count' },
        { header: 'Lead ID', type: 'text' },
        { header: 'Source', type: 'text' },
        ...(ctx.contacts
          ? ([
              { header: 'Contact name', type: 'text' },
              { header: 'Phone', type: 'text' },
              { header: 'Agent', type: 'text' },
            ] satisfies XlsxColumn[])
          : []),
      ],
      rows: rows.map((r) => [
        r.at ? new Date(r.at) : null,
        r.direction,
        r.outcome,
        r.disposition,
        r.talk === null ? null : Number(r.talk),
        r.duration === null ? null : Number(r.duration),
        r.lead,
        r.lead ? sourceLabel(r.channel) : null,
        ...(ctx.contacts ? [r.name, r.number, r.agent] : []),
      ]),
    },
  ];
}

/* ------------------------------------------------------------------------- */
/* Tables already on screen                                                  */
/* ------------------------------------------------------------------------- */

async function sourceSheets(ctx: Ctx): Promise<XlsxSheet[]> {
  const { session, filters } = ctx;
  const [mp, through] = await Promise.all([
    cached.monthlyPerformance(session, filters.range, filters.model),
    cached.sourcesThrough(session),
  ]);
  const { coverageFor, isUnmeasured } = await import('@/lib/coverage');
  const cover = coverageFor(through, filters.range);
  const spendOut = isUnmeasured(cover.spend);
  const crmOut = isUnmeasured(cover.crm);
  const stages = mp.stages.filter((s) => !mp.stageStatus[s.key]?.blocked);
  const valueLabel = mp.stages.find((s) => s.countsValue)?.label ?? 'Funded';
  const rows: XlsxCell[][] = [
    ...mp.channels
      .filter((c) => !filters.source || c.platform === filters.source)
      .map((c): XlsxCell[] => [
        c.label,
        c.paid && !spendOut ? c.spend : null,
        c.paid && !spendOut ? c.impressions : null,
        c.paid && !spendOut ? c.clicks : null,
        ...stages.map((s) => (crmOut ? null : (c.stages[s.key] ?? 0))),
        crmOut ? null : c.valueVolume,
        c.paid && !spendOut && !crmOut ? c.costPerDeal.value : null,
      ]),
    ...(!filters.source || filters.source === 'unattributed'
      ? [
          [
            mp.unattributed.label,
            null,
            null,
            null,
            ...stages.map((s) => (crmOut ? null : (mp.unattributed.stages[s.key] ?? 0))),
            crmOut ? null : mp.unattributed.valueVolume,
            null,
          ] as XlsxCell[],
        ]
      : []),
  ];
  return [
    {
      name: 'Sources',
      columns: [
        { header: 'Source', type: 'text' },
        { header: 'Spend', type: 'money' },
        { header: 'Impressions', type: 'count' },
        { header: 'Clicks', type: 'count' },
        ...stages.map((s): XlsxColumn => ({ header: s.label, type: 'count' })),
        { header: `${valueLabel} volume`, type: 'money' },
        { header: `Cost per ${valueLabel.toLowerCase()} deal`, type: 'money' },
      ],
      rows,
    },
  ];
}

async function rampSheets(ctx: Ctx): Promise<XlsxSheet[]> {
  const { session, filters } = ctx;
  const [buckets, metrics, ramp, frozen, through, stages] = await Promise.all([
    cached.windowBuckets(session, trailingMonths(filters.today, 12), 'month', filters.model),
    cached.loadMetrics(session),
    cached.engagementRamp(session),
    cached.frozenBaseline(session),
    cached.sourcesThrough(session),
    funnelStages(session),
  ]);
  const value = stages.find((s) => s.countsValue) ?? null;
  const valueLabel = value?.label ?? 'Funded';
  const panels = buildRampPanels({
    buckets,
    metrics,
    ramp,
    frozen,
    through,
    valueKey: value?.key ?? null,
    valueLabel,
    currency: session.tenant.currency,
    currentMonth: filters.today.slice(0, 7),
  });
  if (panels.startMonth === null) return [];
  const [y, m, d] = filters.today.split('-').map(Number);
  const elapsed = d! / new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const rows = rampTableRows(panels, { currentMonth: filters.today.slice(0, 7), elapsed });
  const money = (metric: string) => ['budget', 'cpa', 'costPerFundedDeal', 'fundedAmount'].includes(metric);
  return [
    {
      name: 'Engagement ramp',
      columns: [
        { header: 'Month', type: 'text' },
        { header: 'Ramp month', type: 'text' },
        ...RAMP_TABLE_COLUMNS.flatMap((c): XlsxColumn[] => [
          { header: c.label(valueLabel), type: money(c.metric) ? 'money' : 'number' },
          ...(c.targeted ? [{ header: `${c.label(valueLabel)} target`, type: money(c.metric) ? 'money' : 'number' } as XlsxColumn] : []),
        ]),
      ],
      rows: rows.map((r) => [
        r.month,
        r.rampLabel ?? 'baseline',
        ...RAMP_TABLE_COLUMNS.flatMap((c) => {
          const cell = r.cells[c.key];
          return [cell?.actual?.value ?? null, ...(c.targeted ? [cell?.target ?? null] : [])];
        }),
      ]),
    },
  ];
}

/**
 * A list of plain objects as a sheet: one level of nesting flattened, types
 * read from the values, money read from the field's name.
 */
function sheetFrom(name: string, objects: readonly object[]): XlsxSheet {
  const flat = objects.map((o) => {
    const out: Record<string, XlsxCell> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v instanceof Date || v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as XlsxCell;
      else if (Array.isArray(v)) out[k] = v.every((x) => typeof x !== 'object') ? v.join(', ') : null;
      else if (v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) {
          if (v2 instanceof Date || v2 === null || ['string', 'number', 'boolean'].includes(typeof v2)) out[`${k} ${k2}`] = v2 as XlsxCell;
        }
      }
    }
    return out;
  });
  const keys = [...new Set(flat.flatMap((o) => Object.keys(o)))];
  const human = (k: string) => {
    const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const typeOf = (k: string): XlsxColumn['type'] => {
    const sample = flat.map((o) => o[k]).find((v) => v !== null && v !== undefined);
    if (sample instanceof Date) return 'datetime';
    if (typeof sample === 'boolean') return 'boolean';
    if (typeof sample === 'number') return /spend|cost|cpc|cpa|amount|volume|revenue|value$/i.test(k) ? 'money' : 'number';
    if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample)) return 'date';
    return 'text';
  };
  return {
    name,
    columns: keys.map((k) => ({ header: human(k), type: typeOf(k) })),
    rows: flat.map((o) => keys.map((k) => o[k] ?? null)),
  };
}

async function campaignSheets(ctx: Ctx, platform: string, daily: boolean): Promise<XlsxSheet[]> {
  const { session, filters } = ctx;
  const stages = await funnelStages(session);
  const value = stages.find((s) => s.countsValue);
  const view = await cached.platformView(
    session,
    platform,
    platformLabel(platform),
    filters.range,
    value ? { key: value.key, label: value.label } : null,
    filters.model,
  );
  const label = platformLabel(platform);
  return daily
    ? [sheetFrom(`${label} by day`, view.daily)]
    : [sheetFrom(`${label} campaigns`, view.byCampaign), sheetFrom(`${label} by type`, view.byCampaignType)];
}

async function seoSheets(ctx: Ctx): Promise<XlsxSheet[]> {
  const view = await cached.seoView(ctx.session, ctx.filters.range);
  return [
    sheetFrom('SEO by month', view.months),
    sheetFrom('Top organic keywords', view.topKeywords.rows),
    sheetFrom('AI Overview keywords', view.aiOverview.rows),
    sheetFrom('Organic competitors', view.competitors.rows),
    ...(view.tracking ? [sheetFrom('Tracked keywords', 'keywords' in view.tracking ? (view.tracking as { keywords: object[] }).keywords : [view.tracking])] : []),
  ];
}

async function organicSheets(ctx: Ctx, platform: string): Promise<XlsxSheet[]> {
  const view = await cached.organicView(ctx.session, platform as 'ga4' | 'search_console', platformLabel(platform), ctx.filters.range);
  return [
    sheetFrom(`${view.label} by day`, view.daily),
    ...view.breakdowns.map((b) =>
      sheetFrom(`${view.label} ${(b as { label?: string }).label ?? 'breakdown'}`, ((b as { rows?: object[] }).rows ?? []) as object[]),
    ),
  ];
}

/** The Comparison table as one sheet: each row with both periods, its targets and its change. */
async function comparisonSheets(ctx: Ctx): Promise<XlsxSheet[]> {
  const { filters, session } = ctx;
  if (!filters.compare) return [];
  const report = await comparisonReport(session, {
    a: filters.range,
    b: filters.compare,
    source: filters.source ?? 'all',
    model: filters.model,
  });
  const label = report.sources.find((s) => s.key === report.source)?.label ?? 'All sources';
  return [
    {
      name: `Comparison · ${label}`,
      columns: [
        { header: 'Section', type: 'text' },
        { header: 'Metric', type: 'text' },
        { header: `Period A (${filters.range.start} to ${filters.range.end})`, type: 'number' },
        { header: 'A target', type: 'money' },
        { header: 'A based on', type: 'count' },
        { header: `Period B (${filters.compare.start} to ${filters.compare.end})`, type: 'number' },
        { header: 'B target', type: 'money' },
        { header: 'B based on', type: 'count' },
        { header: 'Change (A − B)', type: 'number' },
        { header: '% change', type: 'percent' },
        { header: 'Why no figure (A)', type: 'text' },
        { header: 'Why no figure (B)', type: 'text' },
      ],
      rows: report.rows.map((r) => [
        r.section,
        r.label,
        r.a.value,
        r.a.target?.low ?? null,
        r.a.basis?.n ?? null,
        r.b.value,
        r.b.target?.low ?? null,
        r.b.basis?.n ?? null,
        r.change,
        r.pct,
        r.a.value === null ? r.a.reason : null,
        r.b.value === null ? r.b.reason : null,
      ]),
    },
  ];
}

/* ------------------------------------------------------------------------- */

export async function buildSheets(ctx: Ctx, spec: ExportSpec): Promise<XlsxSheet[]> {
  const platform = spec.platform ?? null;
  switch (spec.dataset) {
    case 'deals':
      return dealSheets(ctx, spec.stage ?? null, platform);
    case 'leads':
      return leadSheets(ctx, spec.stage ?? null, platform);
    case 'lender_decisions':
      return [decisionSheet(await decisionRows(ctx, null, platform))];
    case 'calls':
      return callSheets(ctx);
    case 'sources':
      return sourceSheets(ctx);
    case 'ramp':
      return rampSheets(ctx);
    case 'campaigns':
      return platform ? campaignSheets(ctx, platform, false) : [];
    case 'platform_daily':
      return platform ? campaignSheets(ctx, platform, true) : [];
    case 'seo':
      return seoSheets(ctx);
    case 'organic':
      return platform ? organicSheets(ctx, platform) : [];
    case 'comparison':
      return comparisonSheets(ctx);
  }
}

/** A file name with no personal data in it: the tenant, the export and the dates. */
export function exportFileName(slug: string, what: string, range: DateRange): string {
  const safe = `${slug}-${what}-${range.start}-to-${range.end}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${safe}.xlsx`;
}

/** The audit entry's detail: never a contact value. */
export function auditDetail(what: string, filters: ExportFilters, rows: number, contacts: boolean): ExportAuditDetail {
  return { export: what, from: filters.range.start, to: filters.range.end, source: filters.source, rows, contacts };
}

/** Records an export in the account audit log, as the person who took it. */
export async function recordExport(session: TenantSession, detail: ExportAuditDetail): Promise<void> {
  await queryTenant(session, (tx) =>
    tx.insert(schema.auditEvents).values({
      tenantId: session.tenant.id,
      action: 'export',
      actorUserId: session.viewer.userId,
      actorEmail: session.viewer.email,
      subjectUserId: session.viewer.userId,
      subjectEmail: session.viewer.email,
      detail,
    }),
  );
}

