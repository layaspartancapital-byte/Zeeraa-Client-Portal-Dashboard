/**
 * The Salesforce sync, plus the converted-Lead click-ID backfill.
 *
 *   pnpm --filter @zeeraa/jobs sync-salesforce <tenant-slug> [--since YYYY-MM-DD] [--limit N]
 *
 * Two passes, and the second is the point of this script.
 *
 * Lead field mapping copies a value at the moment of conversion and never
 * retrospectively, so every opportunity that converted before the mapping
 * existed holds a permanent null — which for Spartan is every opportunity,
 * because the Opportunity-side click-ID fields do not exist yet. The values are
 * not lost: a converted Lead still carries its `gclid` and still points at the
 * opportunity it became. `backfillClickIdsFromConvertedLeads` walks that link
 * and writes `source = 'lead_conversion'`, a different key from the mapped
 * field's, so it can never overwrite a value the mapping produced.
 *
 * Attribution is rebuilt at the end, because the whole reason to run the
 * backfill is to see what it recovers.
 */
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { getOwnerDb, schema, withJobTenant, withMaintenance, type Database } from '@zeeraa/db';
import { tenantDay, trailingWindow } from '@zeeraa/core';
import { resolveSalesforceContext } from '../src/salesforce/context';
import { runSalesforceSync } from '../src/salesforce/sync';
import { backfillClickIdsFromConvertedLeads } from '../src/salesforce/backfill';
import { buildAttribution } from '../src/google-ads/join';

const args = process.argv.slice(2);
const slug = args[0];
if (!slug) throw new Error('Usage: tsx scripts/sync-salesforce.ts <tenant-slug> [--since YYYY-MM-DD] [--limit N]');
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const since = arg('since') ? new Date(`${arg('since')}T00:00:00Z`) : undefined;
const limit = arg('limit') ? Number(arg('limit')) : undefined;

const { db, close } = getOwnerDb();

try {
  const { tenantId, connectionId, timezone } = await withMaintenance(db, async (tx) => {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name, timezone: schema.tenants.timezone })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);

    const [connection] = await tx
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.tenantId, tenant.id),
          eq(schema.connections.platform, 'salesforce'),
        ),
      );
    if (!connection) throw new Error(`${tenant.name} has no salesforce connection.`);

    console.log(`${tenant.name} — salesforce`);
    return { tenantId: tenant.id, connectionId: connection.id, timezone: tenant.timezone };
  });

  const context = await resolveSalesforceContext(tenantId, connectionId);
  const runInTenant = <T,>(fn: (tx: Database) => Promise<T>) => withJobTenant(tenantId, fn);

  console.log('\n  ── pass 1: incremental sync ──');
  /*
   * `since` reaches pass 1 as well as pass 2.
   *
   * It did not until 18 September 2026: the flag was read, documented in the
   * usage line above, and then passed only to the click-ID backfill — so
   * `--since 2024-01-01` looked like a full re-pull and quietly ran an
   * ordinary incremental one off the watermark. That is the shape of bug that
   * makes a backfill appear to have run.
   */
  const sync = await runSalesforceSync(context, { trigger: 'manual', since });
  console.log(`  leads:                 ${sync.leads}`);
  console.log(`  opportunities:         ${sync.opportunities}`);
  console.log(`  stage events:          ${sync.stageEvents}`);
  console.log(`  click ids (mapped):    ${sync.clickIds}`);
  console.log(`  deleted / merged:      ${sync.deleted} / ${sync.merged}`);
  console.log(`  revenue disagreements: ${sync.revenueDisagreements}`);
  console.log(`  qualification undetermined: ${sync.qualificationUndetermined}`);
  console.log(`  leads considered:      ${sync.exclusions.considered}`);
  console.log(`  leads excluded:        ${sync.exclusions.excludedTotal} (unclassified ${sync.exclusions.unclassified}, inbound ${sync.exclusions.inbound})`);
  console.log(`  status:                ${sync.status}`);
  if (sync.missingFields.length > 0) {
    console.log(`  mapped fields absent from the org (dropped from the query, non-blocking):`);
    for (const f of sync.missingFields) console.log(`    - ${f}`);
  }
  if (sync.blocked.length > 0) {
    console.log('  BLOCKING mapping problems:');
    for (const b of sync.blocked) console.log(`    - ${b}`);
  }

  console.log('\n  ── stage history (OpportunityFieldHistory) ──');
  const h = sync.stageHistory;
  console.log(`  history rows read:         ${h.rows}`);
  console.log(`  stage events emitted:      ${h.events}`);
  for (const [stage, n] of Object.entries(h.counts)) console.log(`    ${stage}: ${n}`);
  console.log(
    `  retained window observed:  ${h.span.earliest?.toISOString().slice(0, 10) ?? '(none)'} .. ` +
      `${h.span.latest?.toISOString().slice(0, 10) ?? '(none)'}`,
  );
  if (Object.keys(h.unrecognised).length > 0) {
    console.log('  UNRECOGNISED stage labels (add to the alias map):');
    for (const [v, n] of Object.entries(h.unrecognised)) console.log(`    ${v}: ${n}`);
  }

  if (sync.submissions) {
    const sub = sync.submissions;
    const decided = sub.counts.offered + sub.counts.declined;
    console.log('\n  ── lender submissions ──');
    console.log(`  submissions written:       ${sub.rows}`);
    console.log(
      `  offered / declined:        ${sub.counts.offered} / ${sub.counts.declined}` +
        (decided > 0 ? `  (offer rate ${((sub.counts.offered / decided) * 100).toFixed(1)}%)` : ''),
    );
    // Stated, not omitted: these are outside the rate's denominator, and a
    // reader who assumes otherwise is out by a factor of two.
    console.log(`  undecided (excluded):      ${sub.counts.undecided}`);
    console.log(
      `  window observed:           ${sub.span.earliest?.toISOString().slice(0, 10) ?? '(none)'} .. ` +
        `${sub.span.latest?.toISOString().slice(0, 10) ?? '(none)'}`,
    );
    if (Object.keys(sub.unclassified).length > 0) {
      console.log('  UNCLASSIFIED statuses (add to the mapping; counted as undecided):');
      for (const [v, n] of Object.entries(sub.unclassified)) console.log(`    ${v}: ${n}`);
    }
  }

  if (sync.callLeadMatches) {
    const m = sync.callLeadMatches;
    console.log('\n  ── call-to-lead join (re-resolved) ──');
    console.log(`  calls newly matched:       ${m.matched}`);
    console.log(`  unmatched (keyed number):  ${m.unmatched}`);
    console.log(`  unjoinable number:         ${m.unkeyed}`);
  }

  console.log('\n  ── pass 2: click ids from converted leads ──');
  const backfill = await backfillClickIdsFromConvertedLeads({
    tenantId,
    client: context.client,
    mapping: context.mapping,
    since,
    limit,
  });
  console.log(`  converted leads examined:  ${backfill.leadsExamined}`);
  console.log(`  click ids recovered:       ${backfill.clickIdsRecovered}`);
  console.log(`  converted leads with none: ${backfill.leadsWithoutClickId}`);
  console.log(`  by platform:               ${JSON.stringify(backfill.platforms)}`);
  console.log(`  status:                    ${backfill.status}`);
  if (backfill.note) console.log(`  note: ${backfill.note}`);

  console.log('\n  ── attribution rebuilt ──');
  const join = await runInTenant((tx) => buildAttribution(tx, tenantId));
  console.log(`  opportunities with a touch: ${join.opportunities}`);
  console.log(`  attribution rows:           ${join.attributionRows}`);

  // The question the backfill exists to answer: of the deals that funded in the
  // window, how many now carry a click id at all, and how many of those reach a
  // campaign we hold spend for. A click older than click_view's ninety days is
  // known to the CRM and unknown to the ads side — that is a real category, not
  // a rounding error, and it is counted separately from a deal with no click.
  const today = tenantDay(new Date(), timezone);
  const range = trailingWindow(today, 90);
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
          eq(schema.attribution.model, 'last_touch'),
        ),
      )
      .where(
        and(
          eq(schema.stageEvents.tenantId, tenantId),
          eq(schema.stageEvents.stage, 'funded'),
          gte(schema.stageEvents.occurredAt, new Date(`${range.start}T00:00:00Z`)),
          lte(schema.stageEvents.occurredAt, new Date(`${range.end}T23:59:59.999Z`)),
        ),
      ),
  );

  console.log(`\n  ── funded deals, ${range.start} → ${range.end} (last_touch) ──`);
  console.log(`  funded deals:                 ${funded!.deals}`);
  console.log(`  carrying a click id:          ${funded!.withClickId}`);
  console.log(`  resolving to a campaign:      ${funded!.withCampaign}`);
  console.log(`  click id but no campaign:     ${funded!.withClickId - funded!.withCampaign}`);
  console.log(`  no click id at all:           ${funded!.deals - funded!.withClickId}`);
  console.log('\n  Now run: pnpm --filter @zeeraa/jobs spend-to-funded ' + slug);

  if (sync.status !== 'succeeded') process.exitCode = 1;
} finally {
  await close();
  const { closeConnections } = await import('@zeeraa/db');
  await closeConnections();
}
