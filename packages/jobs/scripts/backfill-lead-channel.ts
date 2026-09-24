/**
 * Fills migration 0035's columns for records ingested before the sync stored
 * them, then re-resolves every lead's channel and rebuilds attribution.
 *
 *   DATABASE_URL_JOBS=… DATABASE_URL_MAINT=… ENCRYPTION_KEY=… \
 *     npx tsx scripts/backfill-lead-channel.ts <slug> --dry-run
 *
 *   1. `leads.referrer_url`, read from Salesforce through the mapping's
 *      `referrer` field (`apply-organic-source.ts` adds it).
 *   2. `leads.channel`, resolved for every stored lead by `leadChannel` in
 *      core from what is stored — click, UTM and referrer — so it is exactly
 *      what the sync writes for a new lead.
 *   3. `opportunities.is_closed`, Salesforce's `IsClosed`.
 *   4. `attribution`, rebuilt, which credits a deal with no paid touch to
 *      organic search when its lead proves it.
 *
 * Read-only against Salesforce. `--dry-run` writes, prints what moved and
 * rolls back: under FORCE a denied write matches nothing and exits 0.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getMaintenanceDb, schema, withJobTenant, withMaintenance } from '@zeeraa/db';
import { leadChannel } from '@zeeraa/core';
import type { SalesforceRecord } from '@zeeraa/connectors';
import { resolveSalesforceContext } from '../src/salesforce/context';
import { buildAttribution } from '../src/google-ads/join';

const slug = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');
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
if (!referrerField) throw new Error('The connection maps no lead referrer; run apply-organic-source.ts first.');
if (!ctx.organicSearch) throw new Error('No readable organic_search_evidence row; run apply-organic-source.ts first.');

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
  `SELECT Id, ${referrerField} FROM Lead WHERE CreatedDate >= ${soqlDate(earliest.lead)}`,
  true,
);
const referrers = leadRecords.map((r) => {
  const v = r[referrerField];
  return { id: String(r.Id), url: v == null || String(v).trim() === '' ? null : String(v).trim() };
});
const oppRecords = await ctx.client.query<SalesforceRecord>(
  `SELECT Id, IsClosed FROM Opportunity WHERE CreatedDate >= ${soqlDate(earliest.opp)}`,
  true,
);
const closed = oppRecords.map((r) => ({ id: String(r.Id), closed: r.IsClosed === true }));
console.log(`Read ${leadRecords.length} leads (${referrers.filter((r) => r.url).length} with a referrer) and ${oppRecords.length} opportunities.`);

const report = await withJobTenant(tenantId, async (tx) => {
  let referrerRows = 0;
  for (let i = 0; i < referrers.length; i += 1000) {
    const chunk = referrers.slice(i, i + 1000);
    const updated = await tx.execute<{ id: string }>(sql`
      update leads set referrer_url = v.url
      from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id text, url text)
      where leads.tenant_id = ${tenantId} and leads.external_id = v.id
        and leads.referrer_url is distinct from v.url
      returning leads.id`);
    referrerRows += updated.length;
  }

  const stored = await tx
    .select({
      id: schema.leads.id,
      clickIdType: schema.leads.clickIdType,
      referrerUrl: schema.leads.referrerUrl,
      utmMedium: schema.leads.utmMedium,
      utmCampaign: schema.leads.utmCampaign,
      channel: schema.leads.channel,
    })
    .from(schema.leads)
    .where(eq(schema.leads.tenantId, tenantId));
  const changes = stored
    .map((l) => ({ id: l.id, channel: leadChannel(l, ctx.organicSearch ?? null), was: l.channel }))
    .filter((l) => l.channel !== l.was);
  for (let i = 0; i < changes.length; i += 1000) {
    const chunk = changes.slice(i, i + 1000).map(({ id, channel }) => ({ id, channel }));
    await tx.execute(sql`
      update leads set channel = v.channel
      from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id uuid, channel text)
      where leads.tenant_id = ${tenantId} and leads.id = v.id`);
  }

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
  const organicDeals = await tx.execute<{ n: number }>(
    sql`select count(*)::int n from attribution where tenant_id = ${tenantId} and platform = 'organic_search' and model = 'last_touch'`,
  );
  const openFlag = await tx.execute<{ is_closed: boolean | null; n: number }>(
    sql`select is_closed, count(*)::int n from opportunities where tenant_id = ${tenantId} group by 1 order by 1`,
  );
  console.log(`Referrers written: ${referrerRows}; channels changed: ${changes.length}; is_closed written: ${closedRows}`);
  console.log('Leads by channel:', channels.map((r) => `${r.channel ?? 'unattributed'}=${r.n}`).join(', '));
  console.log(`Deals credited to organic search: ${organicDeals[0]!.n}; attribution rows: ${join.attributionRows}`);
  console.log('Opportunities by is_closed:', openFlag.map((r) => `${String(r.is_closed)}=${r.n}`).join(', '));
  if (DRY_RUN) throw new Rollback();
  return changes.length;
}).catch((e) => {
  if (e instanceof Rollback) return null;
  throw e;
});

console.log(report === null ? 'Dry run: rolled back. Nothing changed.' : 'Backfilled.');
process.exit(0);
