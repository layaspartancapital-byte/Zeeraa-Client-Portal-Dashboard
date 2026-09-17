/**
 * The spend-to-funded join, run against whatever is in the database.
 *
 *   pnpm --filter @zeeraa/jobs spend-to-funded <tenant-slug> [--days 90]
 *
 * Rebuilds `attribution` from the observed click touches, then reports cost per
 * funded deal with its coverage beside it — never on its own. Spartan's click-ID
 * coverage is partial by construction, so a cost per funded deal without the
 * unattributed share next to it is a well-attributed fraction of the truth
 * wearing the whole truth's name (§8).
 *
 * A null cost per funded deal is a real answer. A period with spend and no
 * funded deals does not cost infinity per deal and does not cost zero; it has
 * no cost per deal, and it renders as an empty state rather than as a number.
 */
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { getOwnerDb, schema, withJobTenant, withMaintenance, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow, type AttributionModel } from '@zeeraa/core';
import { buildAttribution, spendToFunded, valueStageKey } from '../src/google-ads/join';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/spend-to-funded.ts <tenant-slug> [--days N]');
const daysIndex = args.indexOf('--days');
const windowDays = daysIndex === -1 ? 90 : Number(args[daysIndex + 1]);

const money = (n: number, currency: string) =>
  `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);

const { db, close } = getOwnerDb();

try {
  const { tenantId, timezone, currency } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({
        id: schema.tenants.id,
        name: schema.tenants.name,
        timezone: schema.tenants.timezone,
        currency: schema.tenants.currency,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    console.log(`${tenant.name} — spend to funded`);
    return { tenantId: tenant.id, timezone: tenant.timezone, currency: tenant.currency };
  });

  const today = tenantDay(new Date(), timezone);
  const range = trailingWindow(today, windowDays);
  console.log(`  window: ${range.start} → ${range.end} (${windowDays} days)\n`);

  const runInTenant = <T,>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn);

  // What the two halves of the join actually hold. Printed before the result
  // because a cost per funded deal computed over an empty CRM is not a small
  // number, it is no number, and the reason has to be visible.
  const inputs = await runInTenant(async (tx) => {
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    return {
      adClicks: await one(
        tx.select({ n: sql<number>`count(*)::int` }).from(schema.adClicks)
          .where(eq(schema.adClicks.tenantId, tenantId)),
      ),
      opportunities: await one(
        tx.select({ n: sql<number>`count(*)::int` }).from(schema.opportunities)
          .where(eq(schema.opportunities.tenantId, tenantId)),
      ),
      stageEvents: await one(
        tx.select({ n: sql<number>`count(*)::int` }).from(schema.stageEvents)
          .where(eq(schema.stageEvents.tenantId, tenantId)),
      ),
      opportunityClickIds: await one(
        tx.select({ n: sql<number>`count(*)::int` }).from(schema.opportunityClickIds)
          .where(eq(schema.opportunityClickIds.tenantId, tenantId)),
      ),
      leadsWithClickId: await one(
        tx.select({ n: sql<number>`count(*)::int` }).from(schema.leads)
          .where(and(eq(schema.leads.tenantId, tenantId), isNotNull(schema.leads.clickId))),
      ),
    };
  });

  const stage = await runInTenant((tx) => valueStageKey(tx, tenantId));
  console.log('  ── inputs ──');
  console.log(`  value stage (counts_value):  ${stage ?? 'NONE CONFIGURED'}`);
  console.log(`  ad_clicks:                   ${inputs.adClicks}`);
  console.log(`  opportunities:               ${inputs.opportunities}`);
  console.log(`  stage_events:                ${inputs.stageEvents}`);
  console.log(`  opportunity_click_ids:       ${inputs.opportunityClickIds}`);
  console.log(`  leads carrying a click id:   ${inputs.leadsWithClickId}`);

  const join = await runInTenant((tx) => buildAttribution(tx, tenantId));
  console.log('\n  ── attribution rebuilt ──');
  console.log(`  opportunities with a touch:  ${join.opportunities}`);
  console.log(`  attribution rows written:    ${join.attributionRows}`);

  for (const model of ['first_touch', 'last_touch'] as AttributionModel[]) {
    const c = join.coverage[model];
    console.log(`\n  ── ${model} ──`);
    // Every opportunity that carries a touch, at any date — not the funded
    // deals in the window. The two are different populations and conflating
    // them overstates coverage, so both are printed and neither is called the
    // other.
    console.log(`  opportunities with a touch:  ${c.total}`);
    console.log(`  touch resolves to a campaign: ${c.attributed}  (${pct(c.rate)})`);
    console.log(`  click id, no campaign:       ${c.clickWithoutCampaign}`);
    console.log(`  no click id at all:          ${c.noTouches}`);

    const [funded] = await runInTenant((tx) =>
      tx
        .select({
          deals: sql<number>`count(distinct ${schema.stageEvents.opportunityExternalId})::int`,
          withClickId: sql<number>`count(distinct ${schema.attribution.opportunityExternalId}) filter (where ${schema.attribution.clickId} is not null)::int`,
          withCampaign: sql<number>`count(distinct ${schema.attribution.opportunityExternalId}) filter (where ${schema.attribution.campaignId} is not null)::int`,
        })
        .from(schema.stageEvents)
        .leftJoin(
          schema.attribution,
          and(
            eq(schema.attribution.tenantId, schema.stageEvents.tenantId),
            eq(schema.attribution.opportunityExternalId, schema.stageEvents.opportunityExternalId),
            eq(schema.attribution.model, model),
          ),
        )
        .where(
          and(
            eq(schema.stageEvents.tenantId, tenantId),
            eq(schema.stageEvents.stage, stage ?? ''),
            gte(schema.stageEvents.occurredAt, new Date(`${range.start}T00:00:00Z`)),
            lte(schema.stageEvents.occurredAt, new Date(`${range.end}T23:59:59.999Z`)),
          ),
        ),
    );
    console.log(`  ${stage ?? 'value-stage'} deals in window:      ${funded!.deals}`);
    console.log(`    carrying a click id:       ${funded!.withClickId}`);
    console.log(`    resolving to a campaign:   ${funded!.withCampaign}`);
    console.log(`    click id, no campaign:     ${funded!.withClickId - funded!.withCampaign}`);
    console.log(`    no click id at all:        ${funded!.deals - funded!.withClickId}`);

    const result = await runInTenant((tx) =>
      spendToFunded(tx, tenantId, 'google_ads', range, model),
    );
    console.log(`  attributed spend:            ${money(result.spend, currency)}`);
    console.log(`  unattributed spend:          ${money(result.unattributedSpend, currency)}`);
    console.log(`  funded deals (attributed):   ${result.fundedDeals}`);
    console.log(`  funded deals (unattributed): ${result.unattributedFundedDeals}`);
    console.log(
      `  COST PER FUNDED DEAL:        ${
        result.value === null
          ? 'no value — no funded deal in the period to divide by'
          : money(result.value, currency)
      }`,
    );

    // The same period's spend over every deal that funded in it, attributed or
    // not. Not the metric — it credits paid spend with deals that may owe it
    // nothing — but printed beside the metric because the distance between the
    // two is the size of the attribution gap, stated in the unit the client
    // thinks in rather than as a percentage.
    const allDeals = result.fundedDeals + result.unattributedFundedDeals;
    const allSpend = result.spend + result.unattributedSpend;
    console.log(
      `  (all spend ÷ all funded deals: ${
        allDeals === 0 ? 'no value' : money(allSpend / allDeals, currency)
      } over ${allDeals} deals — the attribution gap is the distance between these two)`,
    );
  }
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
