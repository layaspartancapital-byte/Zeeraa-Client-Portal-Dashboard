/**
 * Fills migrations 0035 and 0036's columns for records ingested before the
 * sync stored them, applies a Lead Source exclusion added since (ZoomInfo), then
 * re-resolves every lead's channel and rebuilds attribution.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/backfill-lead-channel.ts <slug> --dry-run
 *
 *   1. `leads.referrer_url`, `lead_source` and `braid`, read from Salesforce
 *      through the mapping (`apply-lead-sources.ts` adds the fields).
 *   2. `leads.excluded_reason` for a lead a Lead Source rule now excludes
 *      (`leadSourceExclusion`) — the sync never reads those leads again.
 *   3. `leads.channel`, resolved for every stored lead by `leadChannel` in
 *      core from what is stored, so it is exactly what the sync writes for a
 *      new lead.
 *   4. `opportunities.is_closed`, Salesforce's `IsClosed`.
 *   5. `attribution`, rebuilt, which credits a deal with no click touch to the
 *      source its lead proves.
 *
 * Read-only against Salesforce. `--dry-run` writes, prints what moved and
 * rolls back: under FORCE a denied write matches nothing and exits 0.
 *
 * `--capture-field <Lead field>` and `--organic-capture-page <host/path>`
 * preview a mapping field and a rule not yet stored, in memory, and are refused
 * outside `--dry-run`: the sync reads the stored configuration, so a real run
 * must too (`apply-lead-sources.ts` stores both). The capture page is written
 * to `leads.capture_url` (migration 0044); a real run refuses without it.
 * `--trace <opportunity id>` (repeatable) prints that deal's leads and
 * last-touch source before and after.
 *
 * `--range <from>:<to>` (repeatable) prints each source's leads, MQLs, deals
 * reaching the stage before value, value deals and volume over that range,
 * before and after, as the screens count them — so a rule change can be read
 * from a dry run before anything is written.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, leadChannel as storedChannel, leadsCreatedIn, schema, stageEventsIn, withJobTenant, withMaintenance } from '@zeeraa/db';
import { leadChannel, parseLeadSourceRules, platformLabel, stageBeforeValue, type StageDefinition } from '@zeeraa/core';
import { leadSourceExclusion, NO_LEAD_EXCLUSION, type SalesforceRecord } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';
import { buildAttribution } from '../src/google-ads/join';
import { inheritMergedChannels } from '../src/salesforce/writer';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
const RANGES = process.argv
  .map((a, i, all) => (all[i - 1] === '--range' ? a : null))
  .filter((a): a is string => a !== null)
  .map((a) => {
    const [start, end] = a.split(':');
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error(`--range takes <YYYY-MM-DD>:<YYYY-MM-DD>, not "${a}".`);
    }
    return { start, end };
  });
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};
const CAPTURE_FIELD = flag('--capture-field');
const CAPTURE_PAGE = flag('--organic-capture-page');
const TRACE = process.argv.map((a, i, all) => (all[i - 1] === '--trace' ? a : null)).filter((a): a is string => a !== null);
if (!DRY_RUN && (CAPTURE_FIELD || CAPTURE_PAGE)) {
  throw new Error('--capture-field and --organic-capture-page preview configuration; store it with apply-lead-sources.ts for a real run.');
}
if (!slug || slug.startsWith('--')) throw new Error('Usage: backfill-lead-channel.ts <slug> [--dry-run]');

class Rollback extends Error {}

const { tenantId, connectionId } = await withMaintenance(getMaintenanceDb(), async (tx) => {
  const [t] = await tx.select({ id: schema.tenants.id }).from(schema.tenants).where(eq(schema.tenants.slug, slug));
  if (!t) throw new Error(`No tenant with slug "${slug}".`);
  const [c] = await tx
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(and(eq(schema.connections.tenantId, t.id), eq(schema.connections.platform, 'salesforce')));
  if (!c) throw new Error('No Salesforce connection.');
  return { tenantId: t.id, connectionId: c.id };
});

const ctx = await resolveSalesforceContext(tenantId, connectionId);
const referrerField = ctx.mapping.lead.referrer;
const leadSourceField = ctx.mapping.lead.leadSource;
const braidFields = ctx.mapping.lead.braids ?? [];
if (!referrerField || !leadSourceField) {
  throw new Error('The connection maps no lead referrer or lead source; run apply-lead-sources.ts first.');
}
if (!ctx.leadSources) throw new Error('No readable lead_source_rules row; run apply-lead-sources.ts first.');
const captureField = CAPTURE_FIELD ?? ctx.mapping.lead.capturePage ?? null;
const sourceRules = CAPTURE_PAGE
  ? parseLeadSourceRules({ ...ctx.leadSources, organicCapturePages: [...ctx.leadSources.organicCapturePages, CAPTURE_PAGE] })
  : ctx.leadSources;
if (!sourceRules) throw new Error('--organic-capture-page did not parse.');
if (CAPTURE_FIELD || CAPTURE_PAGE) console.log(`Previewing, not stored: capture field ${captureField}; organic capture pages ${sourceRules.organicCapturePages.join(', ')}`);
const exclusion = ctx.leadExclusion ?? NO_LEAD_EXCLUSION;

const earliest = await withJobTenant(tenantId, async (tx) => {
  const [lead] = await tx.select({ at: sql<Date>`min(${schema.leads.createdAt})` }).from(schema.leads).where(eq(schema.leads.tenantId, tenantId));
  const [opp] = await tx
    .select({ at: sql<Date>`min(${schema.opportunities.createdAt})` })
    .from(schema.opportunities)
    .where(eq(schema.opportunities.tenantId, tenantId));
  return { lead: lead?.at ? new Date(lead.at) : null, opp: opp?.at ? new Date(opp.at) : null };
});
if (!earliest.lead || !earliest.opp) throw new Error('No leads or opportunities stored.');
const soqlDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const leadRecords = await ctx.client.query<SalesforceRecord>(
  `SELECT Id, ${[referrerField, leadSourceField, ...braidFields, ...(captureField ? [captureField] : [])].join(', ')} FROM Lead WHERE CreatedDate >= ${soqlDate(earliest.lead)}`,
  true,
);
const text = (r: SalesforceRecord, f: string) => {
  const v = r[f];
  return v == null || String(v).trim() === '' ? null : String(v).trim();
};
const evidence = leadRecords.map((r) => ({
  id: String(r.Id),
  url: text(r, referrerField),
  source: text(r, leadSourceField),
  braid: braidFields.map((f) => text(r, f)).find((v) => v !== null) ?? null,
  capture: captureField ? text(r, captureField) : null,
}));
const captureOf = new Map(evidence.map((e) => [e.id, e.capture]));
const oppRecords = await ctx.client.query<SalesforceRecord>(
  `SELECT Id, IsClosed FROM Opportunity WHERE CreatedDate >= ${soqlDate(earliest.opp)}`,
  true,
);
const closed = oppRecords.map((r) => ({ id: String(r.Id), closed: r.IsClosed === true }));
console.log(
  `Read ${leadRecords.length} leads (${evidence.filter((r) => r.url).length} with a referrer, ` +
    `${evidence.filter((r) => r.braid).length} with a gbraid/wbraid) and ${oppRecords.length} opportunities.`,
);

type Tx = Parameters<Parameters<typeof withJobTenant>[1]>[0];

/** Per source over each `--range`, counted as the screens count them. */
async function sourceFigures(tx: Tx): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  const [stages] = [await tx.select().from(schema.funnelStages).where(eq(schema.funnelStages.tenantId, tenantId))];
  const defs = stages.map((s) => ({ ...s, source: s.source as StageDefinition['source'] }));
  const value = defs.find((s) => s.countsValue)?.key ?? null;
  const before = stageBeforeValue(defs)?.key ?? null;
  for (const range of RANGES) {
    const leads = await tx.execute<{ channel: string | null; leads: number; mql: number }>(sql`
      select ${storedChannel()} as channel, count(*)::int as leads,
             count(*) filter (where ${schema.leads.mqlVerdict} = 'qualified')::int as mql
      from ${schema.leads}
      where ${schema.leads.tenantId} = ${tenantId} and ${leadsCreatedIn(range)}
      group by 1`);
    const deals = await tx.execute<{ channel: string | null; stage: string; deals: number; volume: string }>(sql`
      select a.platform as channel, e.stage, count(*)::int as deals, coalesce(sum(e.amount), 0)::text as volume
      from (
        select distinct on (${schema.stageEvents.opportunityExternalId}, ${schema.stageEvents.stage})
               ${schema.stageEvents.opportunityExternalId} as opportunity_external_id, ${schema.stageEvents.stage} as stage,
               coalesce(o.funded_amount, o.amount, 0) as amount
        from ${schema.stageEvents}
        left join ${schema.opportunities} o
          on o.tenant_id = ${schema.stageEvents.tenantId} and o.external_id = ${schema.stageEvents.opportunityExternalId}
        where ${schema.stageEvents.tenantId} = ${tenantId} and ${stageEventsIn(range)}
          and ${schema.stageEvents.stage} in (${before ?? ''}, ${value ?? ''})
      ) e
      left join ${schema.attribution} a
        on a.tenant_id = ${tenantId} and a.opportunity_external_id = e.opportunity_external_id and a.model = 'last_touch'
      group by 1, 2`);
    const row = (channel: string | null) => {
      const key = `${range.start}:${range.end}|${channel === null ? 'Direct & other' : platformLabel(channel)}`;
      const r = out.get(key) ?? { leads: 0, mql: 0, before: 0, value: 0, volume: 0 };
      out.set(key, r);
      return r;
    };
    for (const l of leads) Object.assign(row(l.channel), { leads: Number(l.leads), mql: Number(l.mql) });
    for (const d of deals) {
      const r = row(d.channel);
      if (d.stage === before) r.before = Number(d.deals);
      if (d.stage === value) Object.assign(r, { value: Number(d.deals), volume: Number(d.volume) });
    }
  }
  return out;
}

function printFigures(was: Map<string, Record<string, number>>, now: Map<string, Record<string, number>>) {
  const fmt = (r?: Record<string, number>) =>
    r ? `${r.leads} leads, ${r.mql} MQL, ${r.before} before value, ${r.value} value, $${(r.volume ?? 0).toFixed(2)}` : 'none';
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const [range, source] = key.split('|');
    const a = fmt(was.get(key));
    const b = fmt(now.get(key));
    console.log(`${range}  ${source!.padEnd(28)} ${a === b ? `unchanged: ${a}` : `${a}  →  ${b}`}`);
  }
}

/** Each traced deal's leads and last-touch source, as one line. */
async function trace(tx: Tx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of TRACE) {
    const leads = await tx
      .select({ externalId: schema.leads.externalId, channel: storedChannel() })
      .from(schema.leads)
      .where(and(eq(schema.leads.tenantId, tenantId), eq(schema.leads.convertedOpportunityId, id)));
    const [touch] = await tx
      .select({ platform: schema.attribution.platform })
      .from(schema.attribution)
      .where(
        and(
          eq(schema.attribution.tenantId, tenantId),
          eq(schema.attribution.opportunityExternalId, id),
          eq(schema.attribution.model, 'last_touch'),
        ),
      );
    const name = (c: string | null | undefined) => (c ? platformLabel(c) : 'Direct & other');
    out.set(id, `deal ${name(touch?.platform)}; leads ${leads.map((l) => `${l.externalId} ${name(l.channel)}`).join(', ') || 'none'}`);
  }
  return out;
}

const report = await withJobTenant(tenantId, async (tx) => {
  const figuresBefore = RANGES.length > 0 ? await sourceFigures(tx) : null;
  const traceBefore = await trace(tx);
  const [captureColumn] = await tx.execute<{ n: number }>(
    sql`select count(*)::int n from information_schema.columns where table_name = 'leads' and column_name = 'capture_url'`,
  );
  const hasCaptureColumn = Number(captureColumn?.n ?? 0) === 1;
  if (captureField && !hasCaptureColumn && !DRY_RUN) throw new Error('Migration 0044 (leads.capture_url) has not been applied.');
  let evidenceRows = 0;
  for (let i = 0; i < evidence.length; i += 1000) {
    const chunk = evidence.slice(i, i + 1000);
    const updated = await tx.execute<{ id: string }>(sql`
      update leads set referrer_url = v.url, lead_source = v.source, braid = v.braid
      from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id text, url text, source text, braid text)
      where leads.tenant_id = ${tenantId} and leads.external_id = v.id
        and (leads.referrer_url, leads.lead_source, leads.braid) is distinct from (v.url, v.source, v.braid)
      returning leads.id`);
    evidenceRows += updated.length;
  }

  let captureRows = 0;
  if (captureField && hasCaptureColumn) {
    const captures = evidence.map(({ id, capture }) => ({ id, capture }));
    for (let i = 0; i < captures.length; i += 1000) {
      const updated = await tx.execute<{ id: string }>(sql`
        update leads set capture_url = v.capture
        from jsonb_to_recordset(${JSON.stringify(captures.slice(i, i + 1000))}::jsonb) as v(id text, capture text)
        where leads.tenant_id = ${tenantId} and leads.external_id = v.id and leads.capture_url is distinct from v.capture
        returning leads.id`);
      captureRows += updated.length;
    }
  }

  // A Lead Source now excluded (ZoomInfo): the leads already stored are marked,
  // exactly as a cold-outreach lead would never have been read.
  let excludedRows = 0;
  const sources = await tx
    .selectDistinct({ source: schema.leads.leadSource })
    .from(schema.leads)
    .where(and(eq(schema.leads.tenantId, tenantId), sql`${schema.leads.excludedReason} is null`));
  for (const { source } of sources) {
    const rule = leadSourceExclusion(exclusion, source);
    if (!rule) continue;
    const marked = await tx.execute<{ id: string }>(sql`
      update leads set excluded_reason = ${rule.key}
      where tenant_id = ${tenantId} and lead_source = ${source} and excluded_reason is null
      returning id`);
    excludedRows += marked.length;
  }

  const stored = await tx
    .select({
      id: schema.leads.id,
      externalId: schema.leads.externalId,
      clickIdType: schema.leads.clickIdType,
      braid: schema.leads.braid,
      referrerUrl: schema.leads.referrerUrl,
      utmSource: schema.leads.utmSource,
      leadSource: schema.leads.leadSource,
      utmMedium: schema.leads.utmMedium,
      utmCampaign: schema.leads.utmCampaign,
      channel: schema.leads.channel,
    })
    .from(schema.leads)
    .where(eq(schema.leads.tenantId, tenantId));
  const changes = stored
    .map((l) => ({
      id: l.id,
      channel: leadChannel({ ...l, capturePage: captureOf.get(l.externalId) ?? null }, sourceRules),
      was: l.channel,
    }))
    .filter((l) => l.channel !== l.was);
  for (let i = 0; i < changes.length; i += 1000) {
    const chunk = changes.slice(i, i + 1000).map(({ id, channel }) => ({ id, channel }));
    await tx.execute(sql`
      update leads set channel = v.channel
      from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id uuid, channel text)
      where leads.tenant_id = ${tenantId} and leads.id = v.id`);
  }

  // The recompute above reads each lead's own fields only; a merge survivor
  // takes its merged leads' channel back, as the sync does after every run.
  const inherited = await inheritMergedChannels(tx, tenantId);
  console.log(`survivors given a merged lead's channel: ${inherited}`);

  let closedRows = 0;
  for (let i = 0; i < closed.length; i += 1000) {
    const chunk = closed.slice(i, i + 1000);
    const updated = await tx.execute<{ id: string }>(sql`
      update opportunities set is_closed = v.closed
      from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id text, closed boolean)
      where opportunities.tenant_id = ${tenantId} and opportunities.external_id = v.id
        and opportunities.is_closed is distinct from v.closed
      returning opportunities.id`);
    closedRows += updated.length;
  }

  const join = await buildAttribution(tx, tenantId);

  const channels = await tx.execute<{ channel: string | null; n: number }>(
    sql`select channel, count(*)::int n from leads where tenant_id = ${tenantId} group by 1 order by 2 desc`,
  );
  const leadDerived = await tx.execute<{ platform: string; n: number }>(
    sql`select platform, count(*)::int n from attribution where tenant_id = ${tenantId} and model = 'last_touch'
        and click_id is null and platform is not null group by 1 order by 2 desc`,
  );
  const openFlag = await tx.execute<{ is_closed: boolean | null; n: number }>(
    sql`select is_closed, count(*)::int n from opportunities where tenant_id = ${tenantId} group by 1 order by 1`,
  );
  console.log(
    `Evidence written: ${evidenceRows}; newly excluded by Lead Source: ${excludedRows}; ` +
      `channels changed: ${changes.length}; is_closed written: ${closedRows}; ` +
      `capture pages written: ${hasCaptureColumn ? captureRows : 'none (migration 0044 not applied; previewed in memory)'}`,
  );
  console.log('Leads by channel:', channels.map((r) => `${r.channel ?? 'direct & other'}=${r.n}`).join(', '));
  console.log('Deals credited from their lead (no click):', leadDerived.map((r) => `${r.platform}=${r.n}`).join(', '));
  console.log(`Attribution rows: ${join.attributionRows}`);
  console.log('Opportunities by is_closed:', openFlag.map((r) => `${String(r.is_closed)}=${r.n}`).join(', '));
  if (figuresBefore) printFigures(figuresBefore, await sourceFigures(tx));
  const traceAfter = await trace(tx);
  for (const id of TRACE) console.log(`trace ${id}: ${traceBefore.get(id)}  →  ${traceAfter.get(id)}`);
  if (DRY_RUN) throw new Rollback();
  return changes.length;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(report === null ? 'Dry run: rolled back. Nothing changed.' : 'Backfilled.');
process.exit(0);
